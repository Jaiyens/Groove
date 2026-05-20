'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import CorrectionToast from '@/components/CorrectionToast';
import LiveScore from '@/components/LiveScore';
import ProgressBar from '@/components/ProgressBar';
import ReferenceVideo from '@/components/ReferenceVideo';
import SkeletonOverlay from '@/components/SkeletonOverlay';
import { getDance } from '@/lib/dances/fixtures';
import { useGraph } from '@/lib/graph/context';
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
const VIDEO_W = 430;
const VIDEO_H = 700;

interface PageProps {
  params: { danceId: string };
}

export default function PracticePage({ params }: PageProps) {
  const router = useRouter();
  const dance = getDance(params.danceId);
  const { bumpMastery } = useGraph();

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

  // Bail early if invalid id.
  useEffect(() => {
    if (!dance) router.replace('/');
  }, [dance, router]);

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
        video: { width: { ideal: VIDEO_W }, height: { ideal: VIDEO_H }, facingMode: 'user' },
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

  // Init pose extractor after camera is up.
  useEffect(() => {
    if (camState !== 'granted') return;
    let cancelled = false;
    const ex = new PoseExtractor();
    extractorRef.current = ex;
    ex.init()
      .then(() => {
        if (cancelled) ex.close();
      })
      .catch(() => {
        // surface as a hint; scoring will run with no landmarks
      });
    return () => {
      cancelled = true;
      ex.close();
      extractorRef.current = null;
    };
  }, [camState]);

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
      <div className="safe-top relative z-20 flex items-center gap-3 px-4 pt-3 pb-2">
        <Link
          href="/"
          aria-label="Exit practice"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-black/60 ring-1 ring-white/15 text-white"
        >
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M6 18L18 6" />
          </svg>
        </Link>
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
        <SkeletonOverlay landmarks={landmarks} width={VIDEO_W} height={VIDEO_H} mirror />

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
