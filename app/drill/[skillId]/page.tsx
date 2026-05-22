'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import FramingToast from '@/components/FramingToast';
import LiveScore from '@/components/LiveScore';
import ProgressBar from '@/components/ProgressBar';
import SkeletonOverlay from '@/components/SkeletonOverlay';
import { useGraph } from '@/lib/graph/context';
import { getMasteryStore } from '@/lib/mastery/store';
import { attachStream } from '@/lib/pose/cameraAttach';
import { isFramingCalibrated } from '@/lib/pose/framingCalibration';
import { computeJointAngles } from '@/lib/pose/jointAngles';
import { PoseExtractor } from '@/lib/pose/poseExtractor';
import type { PoseLandmark } from '@/lib/pose/types';
import { frameScoreFromSimilarity } from '@/lib/scoring/scorer';
import { cosineSimilarity } from '@/lib/scoring/similarity';
import { neutralReferenceFrame } from '@/lib/scoring/syntheticReference';
import { scoreColor } from '@/lib/scoring/types';

interface PageProps {
  params: { skillId: string };
}

type CamState = 'idle' | 'requesting' | 'granted' | 'needs_tap' | 'denied' | 'unavailable';
type RunState = 'preroll' | 'running' | 'finished';

const PREROLL_SECONDS = 3;
const DRILL_BPM = 100; // gentle for drills

export default function DrillPage({ params }: PageProps) {
  const router = useRouter();
  const search = useSearchParams();
  const { graph, bumpMastery } = useGraph();
  const fromAttempt = search.get('from');

  const skill = graph?.nodes.find((n) => n.id === params.skillId);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const extractorRef = useRef<PoseExtractor | null>(null);
  const rafRef = useRef<number | null>(null);
  const startMsRef = useRef<number | null>(null);
  const accScoreRef = useRef<{ sum: number; n: number }>({ sum: 0, n: 0 });

  const [camState, setCamState] = useState<CamState>('idle');
  const [runState, setRunState] = useState<RunState>('preroll');
  const [prerollLeft, setPrerollLeft] = useState(PREROLL_SECONDS);
  const [landmarks, setLandmarks] = useState<PoseLandmark[] | null>(null);
  const [liveScore, setLiveScore] = useState(0);
  const [progress, setProgress] = useState(0);
  const [finalScore, setFinalScore] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  const duration = skill?.drill_duration_seconds ?? 60;

  useEffect(() => {
    if (graph && !skill) router.replace('/');
  }, [graph, skill, router]);

  useEffect(() => {
    if (typeof window === 'undefined' || isFramingCalibrated()) return;
    const here = `/drill/${params.skillId}${fromAttempt ? `?from=${fromAttempt}` : ''}`;
    router.replace(`/onboarding/frame-check?return=${encodeURIComponent(here)}`);
  }, [params.skillId, fromAttempt, router]);

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
    if (!isFramingCalibrated()) return;
    if (camState === 'idle' && skill) startCamera();
  }, [camState, startCamera, skill]);

  useEffect(() => {
    if (camState !== 'granted') return;
    let cancelled = false;
    const ex = new PoseExtractor();
    extractorRef.current = ex;
    ex.init().then(() => {
      if (cancelled) ex.close();
    });
    return () => {
      cancelled = true;
      ex.close();
      extractorRef.current = null;
    };
  }, [camState]);

  useEffect(() => {
    if (camState !== 'granted' || runState !== 'preroll') return;
    if (prerollLeft <= 0) {
      setRunState('running');
      startMsRef.current = performance.now();
      accScoreRef.current = { sum: 0, n: 0 };
      return;
    }
    const t = setTimeout(() => setPrerollLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [camState, runState, prerollLeft]);

  useEffect(() => {
    if (camState !== 'granted' || runState !== 'running' || !skill) return;
    const durationMs = duration * 1000;
    const loop = () => {
      const v = videoRef.current;
      const ex = extractorRef.current;
      const t0 = startMsRef.current ?? performance.now();
      const sessionT = performance.now() - t0;
      setProgress(Math.min(1, sessionT / durationMs));
      setSecondsLeft(Math.max(0, Math.ceil((durationMs - sessionT) / 1000)));

      if (v && ex?.ready && v.readyState >= 2) {
        const res = ex.detectFromVideo(v, sessionT);
        if (res) {
          setLandmarks(res.landmarks);
          if (res.worldLandmarks.length > 0) {
            const vec = computeJointAngles(res.worldLandmarks);
            const ref = neutralReferenceFrame(sessionT, DRILL_BPM);
            const sim = cosineSimilarity(vec, ref);
            const s = frameScoreFromSimilarity(Math.max(0, sim));
            accScoreRef.current.sum += s;
            accScoreRef.current.n += 1;
            setLiveScore((p) => p * 0.75 + s * 0.25);
          }
        } else {
          setLandmarks(null);
        }
      }
      if (sessionT >= durationMs) {
        const acc = accScoreRef.current;
        const final = acc.n > 0 ? acc.sum / acc.n : 0;
        setFinalScore(final);
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
  }, [camState, runState, skill, duration]);

  // Persist mastery on finish.
  useEffect(() => {
    if (runState !== 'finished' || finalScore === null || !skill) return;
    const store = getMasteryStore();
    store.recordAttempt(`drill:${skill.id}`, { [skill.id]: finalScore }, finalScore);
    bumpMastery();
  }, [runState, finalScore, skill, bumpMastery]);

  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    },
    [],
  );

  const colorClass = useMemo(() => {
    if (finalScore === null) return 'text-white';
    return scoreColor(finalScore).color;
  }, [finalScore]);

  if (!graph) {
    return (
      <main className="flex h-full items-center justify-center text-text-muted">
        Loading…
      </main>
    );
  }
  if (!skill) return null;

  return (
    <main className="flex h-full w-full flex-col bg-black">
      <header className="safe-top flex items-center gap-3 px-4 pt-3 pb-3">
        <button
          type="button"
          onClick={() => {
            if (typeof window !== 'undefined' && window.history.length > 1) {
              router.back();
            } else {
              router.push(fromAttempt ? `/results/${fromAttempt}` : '/');
            }
          }}
          aria-label="Back"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-bg-card text-white active:scale-95"
        >
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-widest text-text-muted">Drill</div>
          <div className="truncate text-base font-bold">{skill.name}</div>
        </div>
        <div className="text-sm font-bold tabular-nums text-text-muted">
          {secondsLeft !== null ? `${secondsLeft}s` : `${duration}s`}
        </div>
      </header>

      <div className="px-4 pb-3">
        <ProgressBar progress={progress} />
      </div>

      {runState !== 'finished' ? (
        <div className="relative flex-1 overflow-hidden bg-bg-card mx-4 rounded-2xl">
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className="absolute inset-0 h-full w-full object-cover [transform:scaleX(-1)]"
          />
          <SkeletonOverlay landmarks={landmarks} videoRef={videoRef} mirror staleAfterMs={400} />
          {runState === 'running' && <FramingToast landmarks={landmarks} />}
          {runState === 'preroll' && camState === 'granted' && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm">
              <div className="text-text-muted text-xs uppercase tracking-widest">Drill starts in</div>
              <div className="mt-2 text-[110px] font-extrabold leading-none tabular-nums text-white">
                {prerollLeft}
              </div>
            </div>
          )}
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
                  <div className="text-xl font-bold">Camera blocked</div>
                  <button
                    type="button"
                    onClick={startCamera}
                    className="mt-4 rounded-full bg-white px-5 py-2 text-black text-sm font-bold"
                  >
                    Try again
                  </button>
                </>
              )}
              {camState === 'needs_tap' && (
                <>
                  <div className="text-xl font-bold">Tap to start</div>
                  <p className="mt-2 text-text-muted text-xs max-w-xs">
                    Your phone blocked autoplay.
                  </p>
                  <button
                    type="button"
                    onClick={handleTapToStart}
                    className="mt-4 rounded-full bg-white px-5 py-2 text-black text-sm font-bold"
                  >
                    Start
                  </button>
                </>
              )}
              {camState === 'unavailable' && (
                <>
                  <div className="text-xl font-bold">No camera</div>
                  <p className="mt-2 text-text-muted text-xs max-w-xs">
                    This browser doesn&apos;t expose getUserMedia.
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center px-6">
          <div className="text-text-muted text-xs uppercase tracking-widest">Drill complete</div>
          <div className={`mt-2 text-[88px] font-extrabold tabular-nums ${colorClass}`}>
            {Math.round(finalScore ?? 0)}
          </div>
          <p className="text-center text-text-muted text-sm max-w-xs mt-2">
            Mastery for <span className="text-white font-semibold">{skill.name}</span> updated.
          </p>
        </div>
      )}

      <div className="safe-bottom px-4 pt-3 pb-4 bg-black">
        {runState !== 'finished' ? (
          <>
            <div className="mb-3 flex items-end justify-between">
              <LiveScore score={liveScore} label="effort" />
              <div className="text-right max-w-[160px]">
                <div className="text-[10px] uppercase tracking-widest text-text-muted">Focus</div>
                <div className="text-xs text-text-muted line-clamp-2">{skill.description}</div>
              </div>
            </div>
          </>
        ) : (
          <div className="space-y-2">
            <Link
              href={fromAttempt ? `/results/${fromAttempt}` : '/'}
              className="block w-full rounded-full bg-white py-4 text-center text-base font-bold text-black"
            >
              {fromAttempt ? 'Back to run' : 'Done'}
            </Link>
            <Link
              href="/"
              className="block w-full text-center text-sm text-text-muted py-2"
            >
              Home
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
