'use client';

// Full-dance final attempt. Split-screen (reference left, you right). When
// the reference song ends, the user's recorded video is uploaded to
// /api/score for a single Gemini-scored verdict — no per-chunk testing.
//
// MediaPipe live feedback is intentionally absent here: the final attempt
// is a performance, not a rehearsal. Per-chunk MediaPipe still lives in
// Mode A (the copy page).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import DanceScoreResult from '@/components/DanceScoreResult';
import { useDance } from '@/lib/dances/useDance';
import { attachStream } from '@/lib/pose/cameraAttach';
import { isFramingCalibrated } from '@/lib/pose/framingCalibration';
import type { DanceScore } from '@/lib/scoring/gemini/score-attempt';

type CamState = 'idle' | 'requesting' | 'granted' | 'needs_tap' | 'denied' | 'unavailable';
type RunState =
  | 'waiting_for_camera'
  | 'ready'
  | 'countdown'
  | 'recording'
  | 'uploading'
  | 'result'
  | 'error';

const COUNTDOWN_SECONDS = 3;

interface PageProps {
  params: { danceId: string };
}

export default function FullAttemptPage({ params }: PageProps) {
  const router = useRouter();
  const { loading, notFound, dance } = useDance(params.danceId);

  useEffect(() => {
    if (!loading && notFound) router.replace('/');
  }, [loading, notFound, router]);

  useEffect(() => {
    if (typeof window === 'undefined' || isFramingCalibrated()) return;
    const here = `/dance/${params.danceId}/full`;
    router.replace(`/onboarding/frame-check?return=${encodeURIComponent(here)}`);
  }, [params.danceId, router]);

  const userVideoRef = useRef<HTMLVideoElement | null>(null);
  const referenceVideoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<BlobPart[]>([]);

  const [camState, setCamState] = useState<CamState>('idle');
  const [runState, setRunState] = useState<RunState>('waiting_for_camera');
  const [countdownLeft, setCountdownLeft] = useState(COUNTDOWN_SECONDS);
  const [result, setResult] = useState<DanceScore | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // --- Camera setup ---

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
      const v = userVideoRef.current;
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
    const v = userVideoRef.current;
    const s = streamRef.current;
    if (!v || !s) {
      startCamera();
      return;
    }
    const playing = await attachStream(v, s);
    setCamState(playing ? 'granted' : 'needs_tap');
  }, [startCamera]);

  useEffect(() => {
    if (camState === 'idle' && !loading && dance) startCamera();
  }, [camState, loading, dance, startCamera]);

  useEffect(() => {
    if (camState === 'granted' && runState === 'waiting_for_camera') {
      setRunState('ready');
    }
  }, [camState, runState]);

  // --- Recording lifecycle ---

  const beginRun = useCallback(() => {
    if (runState !== 'ready') return;
    setCountdownLeft(COUNTDOWN_SECONDS);
    setRunState('countdown');
  }, [runState]);

  useEffect(() => {
    if (runState !== 'countdown') return;
    if (countdownLeft <= 0) {
      startRecording();
      return;
    }
    const t = setTimeout(() => setCountdownLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runState, countdownLeft]);

  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    const ref = referenceVideoRef.current;
    if (!stream || !ref) {
      setErrorMessage('camera or reference video not ready');
      setRunState('error');
      return;
    }
    // Video-only — Gemini scores video, and we don't want to send the user's
    // mic audio to the server.
    const videoOnly = new MediaStream(stream.getVideoTracks());
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
        ? 'video/webm;codecs=vp8'
        : 'video/webm';
    const rec = new MediaRecorder(videoOnly, { mimeType });
    recordedChunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunksRef.current.push(e.data);
    };
    recorderRef.current = rec;
    rec.start();

    ref.currentTime = 0;
    ref.muted = false;
    void ref.play().catch(() => {
      // Autoplay-with-sound rejection — let user retry with a tap.
      setErrorMessage('tap the reference video to unmute and start the song');
      setRunState('error');
    });
    setRunState('recording');
  }, []);

  const handleReferenceEnded = useCallback(() => {
    if (runState !== 'recording') return;
    const rec = recorderRef.current;
    if (!rec) return;
    const stopped = new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
    });
    rec.stop();
    setRunState('uploading');
    void (async () => {
      try {
        await stopped;
        const blob = new Blob(recordedChunksRef.current, { type: rec.mimeType });
        const score = await uploadAndScore(blob, dance?.video_url ?? null);
        setResult(score);
        setRunState('result');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setErrorMessage(message);
        setRunState('error');
      }
    })();
  }, [runState, dance?.video_url]);

  const reset = useCallback(() => {
    recorderRef.current = null;
    recordedChunksRef.current = [];
    setResult(null);
    setErrorMessage(null);
    setCountdownLeft(COUNTDOWN_SECONDS);
    setRunState(camState === 'granted' ? 'ready' : 'waiting_for_camera');
  }, [camState]);

  const exitToLesson = useCallback(() => {
    router.push(`/dance/${params.danceId}`);
  }, [router, params.danceId]);

  // Cleanup on unmount.
  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        recorderRef.current.stop();
      }
      recorderRef.current = null;
    },
    [],
  );

  // --- Render ---

  if (loading || !dance) {
    return (
      <main className="flex h-full items-center justify-center bg-black text-text-muted">
        Loading…
      </main>
    );
  }

  if (runState === 'result' && result) {
    return <DanceScoreResult score={result} onRetry={reset} onExit={exitToLesson} />;
  }

  const referenceUrl = dance.video_url;

  return (
    <main className="relative flex h-full w-full flex-col bg-black text-white">
      <header className="safe-top flex items-center gap-3 px-4 pt-3 pb-2">
        <button
          type="button"
          onClick={exitToLesson}
          className="text-xs font-medium uppercase tracking-[0.18em] text-text-muted hover:text-white"
        >
          ← exit
        </button>
        <div className="flex-1 text-center text-xs font-medium uppercase tracking-[0.18em]">
          {dance.name} · final attempt
        </div>
        <div className="w-10" aria-hidden />
      </header>

      <div className="relative flex flex-1 overflow-hidden">
        {/* Reference (left half) */}
        <div className="relative h-full w-1/2 bg-bg-card">
          {referenceUrl ? (
            <video
              ref={referenceVideoRef}
              src={referenceUrl}
              playsInline
              preload="auto"
              onEnded={handleReferenceEnded}
              className="absolute inset-0 h-full w-full object-contain"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-text-muted">
              no reference video
            </div>
          )}
          <div className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-1 text-[10px] font-bold uppercase tracking-widest ring-1 ring-white/10">
            reference
          </div>
        </div>

        {/* User (right half, mirrored) */}
        <div className="relative h-full w-1/2 bg-bg-card">
          <video
            ref={userVideoRef}
            playsInline
            muted
            autoPlay
            className="absolute inset-0 h-full w-full object-cover [transform:scaleX(-1)]"
          />
          <div className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-1 text-[10px] font-bold uppercase tracking-widest ring-1 ring-white/10">
            you
          </div>
        </div>

        {/* Overlays per state */}
        {runState === 'waiting_for_camera' && (
          <CameraOverlay state={camState} onTap={handleTapToStart} />
        )}

        {runState === 'ready' && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm">
            <div className="text-xs uppercase tracking-widest text-text-muted">ready?</div>
            <div className="mt-3 text-2xl font-bold">Dance the full routine</div>
            <div className="mt-1 text-sm text-text-muted">
              audio will play from the reference side
            </div>
            <button
              type="button"
              onClick={beginRun}
              disabled={!referenceUrl}
              className="mt-6 rounded-full bg-white px-8 py-3 text-sm font-bold uppercase tracking-[0.18em] text-black disabled:opacity-40 active:scale-95"
            >
              start
            </button>
          </div>
        )}

        {runState === 'countdown' && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm">
            <div className="text-xs uppercase tracking-widest text-text-muted">starting in</div>
            <div className="mt-2 text-[140px] font-extrabold leading-none tabular-nums">
              {countdownLeft}
            </div>
          </div>
        )}

        {runState === 'recording' && (
          <div className="absolute left-1/2 -translate-x-1/2 top-3 z-10 flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 ring-1 ring-white/10">
            <span className="block h-2 w-2 rounded-full bg-coral animate-pulse" />
            <span className="text-[10px] font-bold uppercase tracking-widest">recording</span>
          </div>
        )}

        {runState === 'uploading' && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm">
            <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/20 border-t-white" />
            <div className="mt-4 text-sm uppercase tracking-widest">scoring your dance…</div>
            <div className="mt-1 text-xs text-text-muted">this takes 30–60 seconds</div>
          </div>
        )}

        {runState === 'error' && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/80 p-6 text-center backdrop-blur-sm">
            <div className="text-2xl font-bold">something went wrong</div>
            <p className="mt-2 max-w-md text-sm text-text-muted">{errorMessage}</p>
            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={reset}
                className="rounded-full bg-white px-6 py-2 text-sm font-bold uppercase tracking-[0.18em] text-black"
              >
                try again
              </button>
              <button
                type="button"
                onClick={exitToLesson}
                className="rounded-full bg-white/10 px-6 py-2 text-sm font-bold uppercase tracking-[0.18em] text-white ring-1 ring-white/20"
              >
                exit
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function CameraOverlay({ state, onTap }: { state: CamState; onTap: () => void }) {
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black p-8 text-center">
      {state === 'requesting' && (
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/20 border-t-white" />
      )}
      {state === 'denied' && (
        <>
          <div className="text-2xl font-bold">Camera blocked</div>
          <p className="mt-2 text-sm text-text-muted">
            Enable camera in browser settings and reload.
          </p>
        </>
      )}
      {state === 'unavailable' && (
        <div className="text-sm text-text-muted">camera unavailable on this device</div>
      )}
      {state === 'needs_tap' && (
        <button
          type="button"
          onClick={onTap}
          className="rounded-full bg-white px-6 py-3 text-sm font-bold uppercase tracking-[0.18em] text-black"
        >
          allow camera
        </button>
      )}
    </div>
  );
}

async function uploadAndScore(blob: Blob, referenceUrl: string | null): Promise<DanceScore> {
  if (!referenceUrl) throw new Error('no reference video on this dance');
  const form = new FormData();
  form.append('attempt', blob, 'attempt.webm');
  form.append('referenceUrl', referenceUrl);
  const res = await fetch('/api/score', { method: 'POST', body: form });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`/api/score ${res.status}: ${text || res.statusText}`);
  }
  const payload = (await res.json()) as { score: DanceScore };
  return payload.score;
}
