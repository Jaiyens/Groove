'use client';

// Mode C — full attempt. Available only when every chunk has been passed.
// No reference video; audio plays. Full DTW scoring over the entire routine.
// On finish: persist a mastery attempt and route to /results/[sessionId].

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import BackHomeButton from '@/components/BackHomeButton';
import CorrectionToast from '@/components/CorrectionToast';
import FramingToast from '@/components/FramingToast';
import LiveScore from '@/components/LiveScore';
import ProgressBar from '@/components/ProgressBar';
import SkeletonOverlay from '@/components/SkeletonOverlay';
import VolumeControl from '@/components/VolumeControl';
import { useDanceAudio } from '@/lib/audio/danceAudio';
import { useDance } from '@/lib/dances/useDance';
import { useGraph } from '@/lib/graph/context';
import { isFullUnlocked } from '@/lib/mastery/chunkProgress';
import { getMasteryStore } from '@/lib/mastery/store';
import { attachStream } from '@/lib/pose/cameraAttach';
import { isFramingCalibrated } from '@/lib/pose/framingCalibration';
import { computeJointAngles } from '@/lib/pose/jointAngles';
import { PoseExtractor } from '@/lib/pose/poseExtractor';
import type { FrameSample, PoseLandmark } from '@/lib/pose/types';
import { BeatTracker } from '@/lib/scoring/beatTracker';
import {
  correctionHint,
  frameScoreFromSimilarity,
  scoreSession,
} from '@/lib/scoring/scorer';
import { cosineSimilarity } from '@/lib/scoring/similarity';
import {
  generateReferenceSequence,
  neutralReferenceFrame,
} from '@/lib/scoring/syntheticReference';
import type { CorrectionHint } from '@/lib/scoring/types';

type CamState = 'idle' | 'requesting' | 'granted' | 'needs_tap' | 'denied' | 'unavailable';
type RunState = 'waiting_for_camera' | 'preroll' | 'running' | 'finished';

const PREROLL_SECONDS = 3;

interface PageProps {
  params: { danceId: string };
}

export default function FullAttemptPage({ params }: PageProps) {
  const router = useRouter();
  const { bumpMastery } = useGraph();
  const { loading, notFound, dance, chunks } = useDance(params.danceId);

  useEffect(() => {
    if (!loading && notFound) router.replace('/');
  }, [loading, notFound, router]);

  // Gate: Mode C requires every chunk to have been passed.
  const [gateChecked, setGateChecked] = useState(false);
  useEffect(() => {
    if (!dance || chunks.length === 0) return;
    if (!isFullUnlocked(dance.id, chunks.length)) {
      router.replace(`/dance/${dance.id}`);
      return;
    }
    setGateChecked(true);
  }, [dance, chunks.length, router]);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const extractorRef = useRef<PoseExtractor | null>(null);
  const rafRef = useRef<number | null>(null);
  const userFramesRef = useRef<FrameSample[]>([]);
  const startMsRef = useRef<number | null>(null);
  const lastHintAtRef = useRef<number>(0);
  const lastDetectAtRef = useRef<number>(0);

  const [camState, setCamState] = useState<CamState>('idle');
  const [runState, setRunState] = useState<RunState>('waiting_for_camera');
  const [prerollLeft, setPrerollLeft] = useState(PREROLL_SECONDS);
  const [landmarks, setLandmarks] = useState<PoseLandmark[] | null>(null);
  const [liveScore, setLiveScore] = useState(0);
  const [progress, setProgress] = useState(0);
  const [hint, setHint] = useState<CorrectionHint | null>(null);
  const [poseStatus, setPoseStatus] = useState<'ok' | 'lost' | 'failed'>('ok');
  const [volume, setVolume] = useState(1);

  // Framing onboarding gate, same as Mode B.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!isFramingCalibrated()) {
      const here = `/dance/${params.danceId}/full`;
      router.replace(`/onboarding/frame-check?return=${encodeURIComponent(here)}`);
    }
  }, [params.danceId, router]);

  const audio = useDanceAudio(dance?.audio_url ?? null, { initialVolume: volume });
  useEffect(() => {
    audio.setVolume(volume);
  }, [audio, volume]);

  const startCamera = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setCamState('unavailable');
      return;
    }
    setCamState('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
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
    if (camState === 'idle' && gateChecked) startCamera();
  }, [camState, gateChecked, startCamera]);

  useEffect(() => {
    if (camState !== 'granted') return;
    let cancelled = false;
    const ex = new PoseExtractor();
    extractorRef.current = ex;
    setPoseStatus('ok');
    ex.init()
      .then(() => {
        if (cancelled) ex.close();
        else if (runState === 'waiting_for_camera') setRunState('preroll');
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
  }, [camState, runState]);

  useEffect(() => {
    if (runState !== 'preroll') return;
    if (prerollLeft <= 0) {
      setRunState('running');
      startMsRef.current = performance.now();
      userFramesRef.current = [];
      audio.seekMs(0);
      void audio.play();
      return;
    }
    const t = setTimeout(() => setPrerollLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [runState, prerollLeft, audio]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVis = () => {
      if (document.hidden) {
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        audio.pause();
      } else if (runState === 'running' && dance) {
        const elapsedMs = progress * dance.duration_seconds * 1000;
        startMsRef.current = performance.now() - elapsedMs;
        void audio.play();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [runState, progress, dance, audio]);

  useEffect(() => {
    if (runState !== 'running' || !dance) return;
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
          if (poseStatus !== 'ok') setPoseStatus('ok');
          setLandmarks(res.landmarks);
          if (res.worldLandmarks.length > 0) {
            const vec = computeJointAngles(res.worldLandmarks);
            userFramesRef.current.push({ timestampMs: sessionT, vector: vec });
            const ref = neutralReferenceFrame(sessionT, dance.bpm);
            const sim = cosineSimilarity(vec, ref);
            const s = frameScoreFromSimilarity(Math.max(0, sim));
            setLiveScore((prev) => prev * 0.7 + s * 0.3);
            if (sessionT - lastHintAtRef.current >= 200) {
              lastHintAtRef.current = sessionT;
              setHint(correctionHint(vec, ref));
            }
          }
        } else {
          setLandmarks(null);
          if (performance.now() - lastDetectAtRef.current > 1500) {
            if (poseStatus === 'ok') setPoseStatus('lost');
          }
        }
      }

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
  }, [runState, dance, poseStatus]);

  // On finish: persist mastery attempt + go to results.
  useEffect(() => {
    if (runState !== 'finished' || !dance) return;
    audio.stop();
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
  }, [runState, dance, bumpMastery, router, audio]);

  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      audio.stop();
    },
    [audio],
  );

  if (loading || !dance) {
    return (
      <main className="flex h-full items-center justify-center text-text-muted">
        Loading…
      </main>
    );
  }

  const totalBeats = Math.round((dance.duration_seconds * dance.bpm) / 60);

  return (
    <main className="relative flex h-full w-full flex-col bg-black">
      <header className="safe-top relative z-30 flex items-center gap-3 px-4 pt-3 pb-2">
        <BackHomeButton />
        <div className="flex-1">
          <ProgressBar progress={progress} beatCount={totalBeats} />
        </div>
        <VolumeControl volume={volume} onChange={setVolume} />
      </header>

      <div className="relative flex-1 overflow-hidden bg-bg-card">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className="absolute inset-0 h-full w-full object-cover [transform:scaleX(-1)]"
        />
        <SkeletonOverlay landmarks={landmarks} videoRef={videoRef} mirror staleAfterMs={400} />
        {runState === 'running' && <FramingToast landmarks={landmarks} />}

        <div className="absolute left-3 top-3 z-10">
          <CorrectionToast hint={runState === 'running' ? hint : null} />
        </div>

        {poseStatus !== 'ok' && runState === 'running' && (
          <div className="absolute inset-x-0 top-14 z-10 mx-auto w-fit rounded-full bg-accent-amber/20 px-3 py-1.5 text-xs font-semibold text-accent-amber ring-1 ring-accent-amber/40 backdrop-blur-sm">
            {poseStatus === 'lost'
              ? 'pose tracking lost, repositioning…'
              : 'pose tracker unavailable'}
          </div>
        )}

        <div className="absolute left-1/2 -translate-x-1/2 bottom-3 z-10 flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 ring-1 ring-white/10">
          <span className="block h-2 w-2 rounded-full bg-accent animate-pulse" />
          <span className="text-[10px] font-bold uppercase tracking-widest">
            full attempt
          </span>
        </div>

        {runState === 'preroll' && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm">
            <div className="text-xs uppercase tracking-widest text-text-muted">
              Final run
            </div>
            <div className="mt-2 text-[120px] font-extrabold leading-none tabular-nums text-white">
              {prerollLeft}
            </div>
            <div className="mt-3 text-base font-bold">{dance.name}</div>
            <div className="text-xs text-text-muted">audio only · {dance.bpm} BPM</div>
          </div>
        )}

        {runState === 'waiting_for_camera' && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black p-8 text-center">
            {camState === 'requesting' && (
              <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/20 border-t-white" />
            )}
            {camState === 'denied' && (
              <>
                <div className="text-2xl font-bold">Camera blocked</div>
                <p className="mt-2 text-sm text-text-muted">
                  Enable camera in browser settings and reload.
                </p>
              </>
            )}
            {camState === 'unavailable' && (
              <div className="text-sm text-text-muted">camera unavailable</div>
            )}
            {camState === 'needs_tap' && (
              <button
                type="button"
                onClick={handleTapToStart}
                className="rounded-full bg-white px-6 py-3 text-sm font-bold text-black"
              >
                Start
              </button>
            )}
            {camState === 'granted' && (
              <div className="text-sm text-text-muted">loading pose tracker…</div>
            )}
          </div>
        )}
      </div>

      <div className="safe-bottom relative z-30 bg-black px-4 pt-3 pb-4">
        <div className="mb-2 flex items-end justify-between">
          <LiveScore score={liveScore} delta={null} />
          <Link
            href={`/dance/${dance.id}`}
            className="text-[11px] font-bold uppercase tracking-widest text-text-muted"
          >
            cancel
          </Link>
        </div>
      </div>
    </main>
  );
}
