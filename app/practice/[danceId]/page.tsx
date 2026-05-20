'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import BackHomeButton from '@/components/BackHomeButton';
import CorrectionToast from '@/components/CorrectionToast';
import LiveScore from '@/components/LiveScore';
import ProgressBar from '@/components/ProgressBar';
import ReferenceVideo from '@/components/ReferenceVideo';
import SkeletonOverlay from '@/components/SkeletonOverlay';
import { getDance } from '@/lib/dances/fixtures';
import { useGraph } from '@/lib/graph/context';
import type { Dance } from '@/lib/dances/types';
import { getMasteryStore } from '@/lib/mastery/store';
import { attachStream } from '@/lib/pose/cameraAttach';
import { computeJointAngles } from '@/lib/pose/jointAngles';
import { PoseExtractor } from '@/lib/pose/poseExtractor';
import type { FrameSample, PoseLandmark } from '@/lib/pose/types';
import { BeatTracker } from '@/lib/scoring/beatTracker';
import { frameScoreFromSimilarity, correctionHint, scoreSession } from '@/lib/scoring/scorer';
import { cosineSimilarity } from '@/lib/scoring/similarity';
import { neutralReferenceFrame, generateReferenceSequence } from '@/lib/scoring/syntheticReference';
import type { CorrectionHint } from '@/lib/scoring/types';

type CamState = 'idle' | 'requesting' | 'granted' | 'needs_tap' | 'denied' | 'unavailable';
type RunState = 'preroll' | 'running' | 'finished';

const PREROLL_SECONDS = 3;

interface PageProps {
  params: { danceId: string };
}

export default function PracticePage({ params }: PageProps) {
  const router = useRouter();
  const { bumpMastery, graph } = useGraph();
  // Memoise so dependent effects (the detection loop) don't tear down and
  // re-arm every time the parent re-renders (e.g. on a mastery bump). The
  // detection loop's deps include `dance`; without memoisation, the loop
  // was cancelling and restarting unpredictably — which read as "skeleton
  // randomly stops" in practice. See DECISIONS.md (day-2).
  const dance: Dance | undefined = useMemo(
    () => (graph ? getDance(params.danceId, graph) : undefined),
    [graph, params.danceId],
  );

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const refVideoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const extractorRef = useRef<PoseExtractor | null>(null);
  const rafRef = useRef<number | null>(null);
  const beatTrackerRef = useRef<BeatTracker | null>(null);
  const userFramesRef = useRef<FrameSample[]>([]);
  const startMsRef = useRef<number | null>(null);
  const lastHintAtRef = useRef<number>(0);

  const [camState, setCamState] = useState<CamState>('idle');
  const [runState, setRunState] = useState<RunState>('preroll');
  const [prerollLeft, setPrerollLeft] = useState(PREROLL_SECONDS);
  const [landmarks, setLandmarks] = useState<PoseLandmark[] | null>(null);
  const [liveScore, setLiveScore] = useState(0);
  const [progress, setProgress] = useState(0);
  const [hint, setHint] = useState<CorrectionHint | null>(null);
  const [poseStatus, setPoseStatus] = useState<'ok' | 'lost' | 'failed'>('ok');
  const lastDetectAtRef = useRef<number>(0);
  const consecutiveFailuresRef = useRef<number>(0);

  // Bail early if invalid id (only after graph has loaded — otherwise we'd
  // bounce home during the brief window before the graph resolves).
  useEffect(() => {
    if (graph && !dance) router.replace('/');
  }, [graph, dance, router]);

  const lastAttemptScore = useMemo(() => {
    if (!dance) return null;
    if (typeof window === 'undefined') return null;
    const last = getMasteryStore().getLatestAttempt(dance.id);
    return last?.overall_score ?? null;
  }, [dance]);

  // Camera permission + stream attach.
  const startCamera = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setCamState('unavailable');
      return;
    }
    setCamState('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // Don't pin width/height — the device will give us its native sensor
        // dimensions, and the on-canvas projection (lib/pose/projection.ts)
        // handles object-cover crop math so the skeleton always aligns.
        video: { facingMode: 'user' },
        audio: false,
      });
      streamRef.current = stream;
      const v = videoRef.current;
      if (!v) {
        setCamState('needs_tap');
        return;
      }
      const playing = await attachStream(v, stream);
      setCamState(playing ? 'granted' : 'needs_tap');
    } catch {
      setCamState('denied');
    }
  }, []);

  // User-gesture fallback when iOS Safari refuses autoplay.
  const handleTapToStart = useCallback(async () => {
    const v = videoRef.current;
    const s = streamRef.current;
    if (!v || !s) {
      startCamera();
      return;
    }
    const playing = await attachStream(v, s);
    setCamState(playing ? 'granted' : 'needs_tap');
  }, [startCamera]);

  useEffect(() => {
    if (camState === 'idle') startCamera();
  }, [camState, startCamera]);

  // Init pose extractor after camera is up. On failure, surface it.
  useEffect(() => {
    if (camState !== 'granted') return;
    let cancelled = false;
    const ex = new PoseExtractor();
    extractorRef.current = ex;
    setPoseStatus('ok');
    ex.init()
      .then(() => {
        if (cancelled) ex.close();
      })
      .catch((err: unknown) => {
        console.error('PoseExtractor init failed', err);
        if (!cancelled) setPoseStatus('failed');
      });
    return () => {
      cancelled = true;
      ex.close();
      extractorRef.current = null;
    };
  }, [camState]);

  // Pause the RAF loop while the page is hidden — restoring on visibility
  // also re-anchors the session clock so MediaPipe's required monotonic
  // timestamp never has a giant jump that would error the detector.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisChange = () => {
      if (document.hidden) {
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
      } else if (runState === 'running' && startMsRef.current !== null) {
        // Re-anchor session start so the post-hidden frame doesn't have a
        // huge timestamp gap relative to the previous one.
        startMsRef.current = performance.now() - progress * (dance?.duration_seconds ?? 0) * 1000;
      }
    };
    document.addEventListener('visibilitychange', onVisChange);
    return () => document.removeEventListener('visibilitychange', onVisChange);
  }, [runState, progress, dance?.duration_seconds]);

  // Preroll countdown.
  useEffect(() => {
    if (camState !== 'granted' || runState !== 'preroll') return;
    if (prerollLeft <= 0) {
      setRunState('running');
      startMsRef.current = performance.now();
      beatTrackerRef.current = new BeatTracker(dance?.bpm ?? 120, 0);
      userFramesRef.current = [];
      return;
    }
    const t = setTimeout(() => setPrerollLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [camState, runState, prerollLeft, dance?.bpm]);

  // Detection loop.
  useEffect(() => {
    if (camState !== 'granted' || runState !== 'running' || !dance) return;
    const durationMs = dance.duration_seconds * 1000;

    const loop = () => {
      const v = videoRef.current;
      const ex = extractorRef.current;
      const t0 = startMsRef.current ?? performance.now();
      const sessionT = performance.now() - t0;
      setProgress(Math.min(1, sessionT / durationMs));

      if (v && ex?.ready && v.readyState >= 2) {
        const res = ex.detectFromVideo(v, sessionT);
        if (res) {
          lastDetectAtRef.current = performance.now();
          consecutiveFailuresRef.current = 0;
          if (poseStatus !== 'ok') setPoseStatus('ok');
          setLandmarks(res.landmarks);
          if (res.worldLandmarks.length > 0) {
            const vec = computeJointAngles(res.worldLandmarks);
            userFramesRef.current.push({ timestampMs: sessionT, vector: vec });
            const ref = neutralReferenceFrame(sessionT, dance.bpm);
            const sim = cosineSimilarity(vec, ref);
            const s = frameScoreFromSimilarity(Math.max(0, sim));
            // Light smoothing on the displayed score so digits don't twitch.
            setLiveScore((prev) => prev * 0.7 + s * 0.3);
            // Throttle hint updates to ~5 Hz.
            if (sessionT - lastHintAtRef.current >= 200) {
              lastHintAtRef.current = sessionT;
              setHint(correctionHint(vec, ref));
            }
          }
        } else {
          // Detector returned no pose this frame — body out of frame, occluded,
          // or detector hiccup. If we go too long with no detection, flag it.
          if (performance.now() - lastDetectAtRef.current > 1500) {
            if (poseStatus === 'ok') setPoseStatus('lost');
          }
          consecutiveFailuresRef.current += 1;
        }
      }
      beatTrackerRef.current?.tick(sessionT);

      if (sessionT >= durationMs) {
        setRunState('finished');
        return;
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [camState, runState, dance]);

  // On finish, compute final score, persist, navigate.
  useEffect(() => {
    if (runState !== 'finished' || !dance) return;
    const store = getMasteryStore();
    const ref = generateReferenceSequence(dance.duration_seconds, dance.bpm);
    const beatGrid = new BeatTracker(dance.bpm, 0).asGrid();
    const result = scoreSession({
      userFrames: userFramesRef.current,
      referenceFrames: ref,
      beatGrid,
      skillIds: [...dance.required_skills],
    });
    const attempt = store.recordAttempt(
      dance.id,
      Object.fromEntries(
        Object.entries(result.perSkillScores).map(([k, v]) => [k, v]),
      ),
      result.overall,
    );
    bumpMastery();
    router.replace(`/results/${attempt.attempt_id}`);
  }, [runState, dance, bumpMastery, router]);

  // Cleanup tracks on unmount.
  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    },
    [],
  );

  if (!dance) {
    return (
      <main className="flex h-full items-center justify-center p-8 text-text-muted">
        Loading…
      </main>
    );
  }

  const totalBeats = Math.round((dance.duration_seconds * dance.bpm) / 60);

  return (
    <main className="relative flex h-full w-full flex-col bg-black">
      {/* Top bar */}
      <div className="safe-top relative z-50 flex items-center gap-3 px-4 pt-3 pb-2">
        <BackHomeButton />
        <div className="flex-1">
          <ProgressBar progress={progress} beatCount={totalBeats} />
        </div>
        <div className="text-[11px] font-bold tabular-nums text-text-muted">
          {Math.max(0, Math.ceil(dance.duration_seconds - progress * dance.duration_seconds))}s
        </div>
      </div>

      {/* Camera + overlays */}
      <div className="relative flex-1 overflow-hidden bg-bg-card">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className="absolute inset-0 h-full w-full object-cover [transform:scaleX(-1)]"
        />
        <SkeletonOverlay landmarks={landmarks} videoRef={videoRef} mirror />

        {/* Pose-tracking status toast */}
        {poseStatus !== 'ok' && runState === 'running' && (
          <div className="absolute inset-x-0 top-14 z-20 mx-auto w-fit max-w-[90%] rounded-full bg-accent-amber/20 px-3 py-1.5 text-xs font-semibold text-accent-amber ring-1 ring-accent-amber/40 backdrop-blur-sm">
            {poseStatus === 'lost'
              ? 'pose tracking lost, repositioning…'
              : 'pose tracker unavailable — score paused'}
          </div>
        )}

        {/* PiP reference */}
        <div className="absolute right-3 top-3 h-32 w-24 z-10">
          <ReferenceVideo dance={dance} videoRef={refVideoRef} muted autoplay={runState === 'running'} />
        </div>

        {/* Correction toast */}
        <div className="absolute left-3 top-3 z-10">
          <CorrectionToast hint={runState === 'running' ? hint : null} />
        </div>

        {/* LIVE indicator */}
        <div className="absolute left-1/2 -translate-x-1/2 bottom-3 z-10 flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 ring-1 ring-white/10">
          <span className="block h-2 w-2 rounded-full bg-accent animate-pulse" />
          <span className="text-[10px] font-bold uppercase tracking-widest">live</span>
        </div>

        {/* Preroll overlay */}
        {runState === 'preroll' && camState === 'granted' && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm">
            <div className="text-text-muted text-xs uppercase tracking-widest">Get ready</div>
            <div className="mt-2 text-[120px] font-extrabold leading-none tabular-nums text-white">
              {prerollLeft}
            </div>
            <div className="mt-4 text-base font-bold">{dance.name}</div>
            <div className="text-sm text-text-muted">{dance.artist} · {dance.bpm} BPM</div>
          </div>
        )}

        {/* Camera permission states */}
        {camState !== 'granted' && (
          <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-black p-8 text-center">
            {camState === 'requesting' && (
              <>
                <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/20 border-t-white" />
                <div className="mt-4 text-text-muted">Requesting camera…</div>
              </>
            )}
            {camState === 'denied' && (
              <>
                <div className="text-2xl font-bold">Camera blocked</div>
                <p className="mt-2 text-text-muted text-sm">
                  Groove needs camera access to see your moves. Enable it in your browser settings and reload.
                </p>
                <button
                  type="button"
                  onClick={startCamera}
                  className="mt-6 rounded-full bg-white px-6 py-2.5 text-black text-sm font-bold"
                >
                  Try again
                </button>
                <Link href="/" className="mt-3 text-sm text-text-muted">Back home</Link>
              </>
            )}
            {camState === 'unavailable' && (
              <>
                <div className="text-2xl font-bold">No camera</div>
                <p className="mt-2 text-text-muted text-sm">
                  This device or browser doesn&apos;t expose getUserMedia. Try a Chromium-based mobile browser.
                </p>
                <Link
                  href="/"
                  className="mt-6 rounded-full bg-white px-6 py-2.5 text-black text-sm font-bold"
                >
                  Back home
                </Link>
              </>
            )}
            {camState === 'idle' && (
              <button
                type="button"
                onClick={startCamera}
                className="rounded-full bg-white px-6 py-3 text-black text-sm font-bold"
              >
                Enable camera
              </button>
            )}
            {camState === 'needs_tap' && (
              <>
                <div className="text-2xl font-bold">Tap to start camera</div>
                <p className="mt-2 text-text-muted text-sm max-w-xs">
                  Your phone blocked autoplay. Tap below to begin the video preview.
                </p>
                <button
                  type="button"
                  onClick={handleTapToStart}
                  className="mt-6 rounded-full bg-white px-6 py-3 text-black text-sm font-bold"
                >
                  Start
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Bottom panel */}
      <div className="safe-bottom relative z-20 px-4 pt-3 pb-4 bg-black">
        <div className="mb-3 flex items-end justify-between">
          <LiveScore
            score={liveScore}
            delta={lastAttemptScore !== null ? liveScore - lastAttemptScore : null}
          />
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-widest text-text-muted">
              {dance.name}
            </div>
            <div className="text-sm font-semibold">{dance.artist}</div>
          </div>
        </div>
        <div className="flex items-center justify-around">
          <button
            type="button"
            aria-label="Rewind"
            className="flex h-11 w-11 items-center justify-center rounded-full bg-bg-card text-white/70 active:scale-95"
            onClick={() => {
              startMsRef.current = performance.now();
              setLiveScore(0);
              setProgress(0);
              userFramesRef.current = [];
            }}
          >
            <svg width={18} height={18} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M11 19 4 12l7-7v4c5 0 9 3 9 9-2-3-5-4-9-4z" />
            </svg>
          </button>
          <button
            type="button"
            aria-label="Pause"
            className="flex h-14 w-14 items-center justify-center rounded-full bg-white text-black active:scale-95"
          >
            <svg width={20} height={20} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <rect x="6" y="5" width="4" height="14" rx="1" />
              <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
          </button>
          <button
            type="button"
            aria-label="Skip"
            className="flex h-11 w-11 items-center justify-center rounded-full bg-bg-card text-white/70 active:scale-95"
            onClick={() => setRunState('finished')}
          >
            <svg width={18} height={18} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="m5 5 9 7-9 7zM16 5h3v14h-3z" />
            </svg>
          </button>
        </div>
      </div>
    </main>
  );
}
