'use client';

// Mode B — scored chunk test.
//
// Camera goes full-screen. Reference video unmounted. Reference dance audio
// plays so the user has the beat. Skeleton overlay on. DTW scores the user
// against the synthetic reference for [chunk.startMs, chunk.endMs].
// On finish: score popup. If >= PASS_THRESHOLD → unlock next chunk and offer
// next-chunk CTA; else offer try-again / back-to-copy.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import BackHomeButton from '@/components/BackHomeButton';
import CorrectionToast from '@/components/CorrectionToast';
import FramingToast from '@/components/FramingToast';
import SkeletonOverlay from '@/components/SkeletonOverlay';
import StartOverlay from '@/components/StartOverlay';
import VolumeControl from '@/components/VolumeControl';
import { useDanceAudio } from '@/lib/audio/danceAudio';
import { useDance } from '@/lib/dances/useDance';
import {
  PASS_THRESHOLD,
  recordChunkScore,
} from '@/lib/mastery/chunkProgress';
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
import { scoreColor } from '@/lib/scoring/types';

type CamState = 'idle' | 'requesting' | 'granted' | 'needs_tap' | 'denied' | 'unavailable';
// SPECK round-4 §Fix 2: scoring does not auto-start after camera grants.
// `ready` shows the StartOverlay; tapping start kicks the overlay's own
// 3-2-1-GO countdown, and onGo flips state to `running`.
type RunState = 'waiting_for_camera' | 'ready' | 'running' | 'finished';

interface PageProps {
  params: { danceId: string; chunkIndex: string };
}

export default function TestPage({ params }: PageProps) {
  const router = useRouter();
  const chunkIndex = Number(params.chunkIndex);
  const { loading, notFound, dance, chunks } = useDance(params.danceId);
  const chunk = chunks[chunkIndex];

  // SPECK §4 onboarding: first time the user enters the scored test flow,
  // route through the framing-check screen and come back here. Pure client
  // gate (no SSR concern — useEffect always runs in the browser).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!isFramingCalibrated()) {
      const here = `/dance/${params.danceId}/chunk/${chunkIndex}/test`;
      router.replace(`/onboarding/frame-check?return=${encodeURIComponent(here)}`);
    }
  }, [params.danceId, chunkIndex, router]);

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
  const [landmarks, setLandmarks] = useState<PoseLandmark[] | null>(null);
  const [liveScore, setLiveScore] = useState(0);
  const [progress, setProgress] = useState(0);
  const [hint, setHint] = useState<CorrectionHint | null>(null);
  const [poseStatus, setPoseStatus] = useState<'ok' | 'lost' | 'failed'>('ok');
  const [confidence, setConfidence] = useState<number | null>(null);
  const [finalScore, setFinalScore] = useState<number | null>(null);
  const [unlockedNext, setUnlockedNext] = useState(false);
  const [volume, setVolume] = useState(1);

  const audio = useDanceAudio(dance?.audio_url ?? null, {
    initialVolume: volume,
    loop: false,
  });
  // Mirror volume changes into the audio element.
  useEffect(() => {
    audio.setVolume(volume);
  }, [audio, volume]);

  // Camera.
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
    if (camState === 'idle') startCamera();
  }, [camState, startCamera]);

  // Pose extractor init.
  useEffect(() => {
    if (camState !== 'granted') return;
    let cancelled = false;
    const ex = new PoseExtractor();
    extractorRef.current = ex;
    setPoseStatus('ok');
    ex.init()
      .then(() => {
        if (cancelled) ex.close();
        else if (runState === 'waiting_for_camera') setRunState('ready');
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

  // SPECK round-4 §Fix 2: invoked by StartOverlay when its 3-2-1
  // countdown lands on zero. This is the exact instant audio + scoring
  // start, so the user's first dance step lines up with the beat. The
  // emphasis "GO" tick is fired inside the overlay itself.
  const handleOverlayGo = useCallback(() => {
    if (!chunk || !dance) return;
    setRunState('running');
    startMsRef.current = performance.now();
    userFramesRef.current = [];
    audio.seekMs(chunk.startMs);
    void audio.play();
  }, [audio, chunk, dance]);

  // Visibility pause/resume — re-anchor session clock so MediaPipe doesn't
  // see a giant timestamp jump.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVis = () => {
      if (document.hidden) {
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        audio.pause();
      } else if (runState === 'running' && chunk) {
        const elapsedMs = progress * (chunk.endMs - chunk.startMs);
        startMsRef.current = performance.now() - elapsedMs;
        void audio.play();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [runState, progress, chunk, audio]);

  // Detection loop scoped to the chunk's duration.
  useEffect(() => {
    if (runState !== 'running' || !dance || !chunk) return;
    const durationMs = chunk.endMs - chunk.startMs;

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
          setConfidence(res.confidence);
          if (res.worldLandmarks.length > 0) {
            const vec = computeJointAngles(res.worldLandmarks);
            // Tag the frame with the absolute routine timestamp so DTW lines
            // up with the chunk-aligned reference.
            userFramesRef.current.push({
              timestampMs: chunk.startMs + sessionT,
              vector: vec,
            });
            const ref = neutralReferenceFrame(chunk.startMs + sessionT, dance.bpm);
            const sim = cosineSimilarity(vec, ref);
            const s = frameScoreFromSimilarity(Math.max(0, sim));
            setLiveScore((prev) => prev * 0.7 + s * 0.3);
            if (sessionT - lastHintAtRef.current >= 200) {
              lastHintAtRef.current = sessionT;
              setHint(correctionHint(vec, ref));
            }
          }
        } else {
          // SPECK §4.2: when detection returns nothing, hide the skeleton
          // rather than freezing the last frame; FramingToast picks this up
          // as zero confidence after the configured hold window.
          setLandmarks(null);
          setConfidence(0);
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
  }, [runState, dance, chunk, poseStatus]);

  // On finish: compute final score, persist chunk progress.
  useEffect(() => {
    if (runState !== 'finished' || !dance || !chunk) return;
    audio.stop();
    const refSeq = generateReferenceSequence(dance.duration_seconds, dance.bpm)
      .filter(
        (f) => f.timestampMs >= chunk.startMs && f.timestampMs < chunk.endMs,
      );
    const beatGrid = new BeatTracker(dance.bpm, chunk.startMs).asGrid();
    const result = scoreSession({
      userFrames: userFramesRef.current,
      referenceFrames: refSeq,
      beatGrid,
      skillIds: chunk.skills,
    });
    const overall = Math.round(result.overall);
    setFinalScore(overall);
    const { unlockedNext } = recordChunkScore(dance.id, chunkIndex, overall);
    setUnlockedNext(unlockedNext);
  }, [runState, dance, chunk, chunkIndex, audio]);

  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      audio.stop();
    },
    [audio],
  );

  useEffect(() => {
    if (!loading && (notFound || (dance && !chunk))) {
      router.replace(`/dance/${params.danceId}`);
    }
  }, [loading, notFound, dance, chunk, router, params.danceId]);

  if (loading || !dance || !chunk) {
    return (
      <main className="flex h-full items-center justify-center text-text-muted">
        Loading…
      </main>
    );
  }

  const passed = finalScore !== null && finalScore >= PASS_THRESHOLD;
  const hasNextChunk = chunkIndex + 1 < chunks.length;
  const scoreUI = scoreColor(finalScore ?? 0);

  return (
    <main className="relative flex h-full w-full flex-col bg-black">
      <header className="safe-top relative z-30 flex items-center gap-3 px-4 pt-3 pb-2">
        <BackHomeButton />
        <div className="flex-1 text-center">
          <div className="text-[10px] uppercase tracking-widest text-text-muted">
            Test · chunk {chunkIndex + 1}/{chunks.length}
          </div>
          <div className="truncate text-sm font-bold">{chunk.label}</div>
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
        {runState === 'running' && <FramingToast confidence={confidence} />}

        {/* Chunk progress + live score pill */}
        <div className="pointer-events-none absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2">
          {chunks.map((c) => (
            <span
              key={c.index}
              className={`h-1 w-5 rounded-full ${
                c.index === chunkIndex
                  ? 'bg-white'
                  : c.index < chunkIndex
                    ? 'bg-white/60'
                    : 'bg-white/20'
              }`}
              aria-hidden
            />
          ))}
        </div>

        <div className="absolute left-3 top-14 z-10">
          <CorrectionToast hint={runState === 'running' ? hint : null} />
        </div>

        {poseStatus !== 'ok' && runState === 'running' && (
          <div className="absolute inset-x-0 top-24 z-10 mx-auto w-fit rounded-full bg-accent-amber/20 px-3 py-1.5 text-xs font-semibold text-accent-amber ring-1 ring-accent-amber/40 backdrop-blur-sm">
            {poseStatus === 'lost'
              ? 'pose tracking lost, repositioning…'
              : 'pose tracker unavailable'}
          </div>
        )}

        <div className="absolute right-3 bottom-3 z-10 rounded-full bg-black/70 px-3 py-1.5 text-sm font-bold tabular-nums text-white ring-1 ring-white/15">
          {Math.round(liveScore)}
        </div>

        {/* SPECK round-4 §Fix 2: press-start gate + 3-2-1 countdown.
            The overlay handles its own audible ticks via lib/audio/tick. */}
        {runState === 'ready' && (
          <StartOverlay
            chunkNumber={chunkIndex + 1}
            totalChunks={chunks.length}
            chunkLabel={chunk.label ?? `section ${chunkIndex + 1}`}
            subtitle="ready to dance?"
            onGo={handleOverlayGo}
          />
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
                <button
                  type="button"
                  onClick={startCamera}
                  className="mt-6 rounded-full bg-white px-6 py-2.5 text-sm font-bold text-black"
                >
                  Try again
                </button>
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

        {/* Final score popup */}
        {runState === 'finished' && finalScore !== null && (
          <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-black/90 px-8 text-center">
            <div className="text-xs uppercase tracking-widest text-text-muted">
              {passed ? 'Chunk passed' : 'Almost there'}
            </div>
            <div className={`mt-1 text-[108px] font-extrabold leading-none tabular-nums ${scoreUI.color}`}>
              {finalScore}
            </div>
            <div className="text-xs text-text-muted">
              threshold {PASS_THRESHOLD}
            </div>

            {passed && unlockedNext && hasNextChunk && (
              <div className="mt-3 text-sm font-bold text-accent-green">
                Chunk {chunkIndex + 2} unlocked
              </div>
            )}
            {passed && !hasNextChunk && (
              <div className="mt-3 text-sm font-bold text-accent-green">
                All chunks complete — try the full attempt
              </div>
            )}

            <div className="mt-6 flex w-full max-w-xs flex-col gap-2">
              {passed ? (
                hasNextChunk ? (
                  <Link
                    href={`/dance/${dance.id}/chunk/${chunkIndex + 1}/copy`}
                    className="rounded-full bg-white py-3 text-center text-sm font-bold text-black"
                  >
                    Next chunk
                  </Link>
                ) : (
                  <Link
                    href={`/dance/${dance.id}/full`}
                    className="rounded-full bg-white py-3 text-center text-sm font-bold text-black"
                  >
                    Full attempt
                  </Link>
                )
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setRunState('ready');
                    setFinalScore(null);
                    setLiveScore(0);
                    setProgress(0);
                  }}
                  className="rounded-full bg-white py-3 text-sm font-bold text-black"
                >
                  Try again
                </button>
              )}
              <Link
                href={`/dance/${dance.id}/chunk/${chunkIndex}/copy`}
                className="rounded-full bg-bg-card py-3 text-center text-sm font-bold text-white ring-1 ring-white/10"
              >
                Back to copy-along
              </Link>
              <Link
                href={`/dance/${dance.id}`}
                className="py-2 text-center text-xs text-text-muted"
              >
                Back to lesson
              </Link>
            </div>
          </div>
        )}
      </div>

      <div className="safe-bottom relative z-30 bg-black px-4 pb-4 pt-2">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full bg-white transition-[width] duration-100"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      </div>
    </main>
  );
}
