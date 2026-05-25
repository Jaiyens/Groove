'use client';

// Final test — user dances alone, no reference visible. A hidden <video>
// element off-screen plays the reference so its audio drives the timing,
// MediaRecorder captures the user, and on the song's end we upload to
// /api/score and render DanceScoreResult.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { upload } from '@vercel/blob/client';
import CameraPermissionBanner, {
  type CamState,
} from '@/components/CameraPermissionBanner';
import DanceScoreResult from '@/components/DanceScoreResult';
import StartOverlay from '@/components/StartOverlay';
import { useDance } from '@/lib/dances/useDance';
import { attachStream } from '@/lib/pose/cameraAttach';
import { markCameraGranted } from '@/lib/preferences/cameraGrant';
import type { DanceScore } from '@/lib/scoring/gemini/score-attempt';

type RunState = 'idle' | 'recording' | 'uploading' | 'result' | 'error';

interface PageProps {
  params: { danceId: string };
}

export default function FinalTestPage({ params }: PageProps) {
  const router = useRouter();
  const { loading, notFound, dance } = useDance(params.danceId);

  useEffect(() => {
    if (!loading && notFound) router.replace('/');
  }, [loading, notFound, router]);

  const camVideoRef = useRef<HTMLVideoElement | null>(null);
  const audioVideoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<BlobPart[]>([]);

  const [camState, setCamState] = useState<CamState>('idle');
  const [runState, setRunState] = useState<RunState>('idle');
  const [result, setResult] = useState<DanceScore | null>(null);
  // Local-only blob URL for the user's just-recorded attempt. Lets the
  // results screen render the attempt side-by-side with the reference
  // without re-downloading from blob storage (we delete the blob server-
  // side after scoring for privacy).
  const [attemptLocalUrl, setAttemptLocalUrl] = useState<string | null>(null);
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
      const v = camVideoRef.current;
      if (!v) {
        setCamState('needs_tap');
        return;
      }
      const playing = await attachStream(v, stream);
      const nextState: CamState = playing ? 'granted' : 'needs_tap';
      setCamState(nextState);
      if (nextState === 'granted') markCameraGranted();
    } catch {
      setCamState('denied');
    }
  }, []);

  useEffect(() => {
    if (camState === 'idle' && !loading && dance) startCamera();
  }, [camState, loading, dance, startCamera]);

  // --- Recording ---

  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    const audioEl = audioVideoRef.current;
    if (!stream || !audioEl) {
      setErrorMessage('camera or reference not ready');
      setRunState('error');
      return;
    }
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

    audioEl.currentTime = 0;
    audioEl.muted = false;
    audioEl.volume = 1;
    void audioEl.play().catch(() => {
      setErrorMessage("couldn't start audio — tap the screen and try again");
      setRunState('error');
    });
    setRunState('recording');
  }, []);

  const handleAudioEnded = useCallback(() => {
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
        // Hold on to the local bytes for the side-by-side replay on the
        // results screen. Cheap (createObjectURL) and stays valid until
        // we revokeObjectURL on reset or unmount.
        const localUrl = URL.createObjectURL(blob);
        setAttemptLocalUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return localUrl;
        });
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
    setAttemptLocalUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setErrorMessage(null);
    setRunState('idle');
  }, []);

  const exitToLesson = useCallback(() => {
    // Stop the camera + recorder + drop the local attempt URL BEFORE
    // we navigate away. Otherwise the next page boots while the
    // <video src="blob:..."> elements in DanceScoreResult are still
    // mounted, and Safari sometimes throws on those when the
    // navigation tears them down mid-decode. Using router.replace so
    // browser-back doesn't dump the user back onto a torn-down score
    // screen.
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    } catch {
      /* ignore */
    }
    try {
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        recorderRef.current.stop();
      }
    } catch {
      /* ignore */
    }
    if (attemptLocalUrl) {
      try { URL.revokeObjectURL(attemptLocalUrl); } catch { /* ignore */ }
    }
    router.replace(`/dance/${params.danceId}`);
  }, [router, params.danceId, attemptLocalUrl]);

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
  // Free the local attempt URL when this page unmounts so we don't leak
  // the blob bytes after navigating away.
  useEffect(() => {
    return () => {
      if (attemptLocalUrl) URL.revokeObjectURL(attemptLocalUrl);
    };
  }, [attemptLocalUrl]);

  if (loading || !dance) {
    return (
      <main className="flex h-full items-center justify-center bg-black text-white/60">
        Loading…
      </main>
    );
  }

  if (runState === 'result' && result) {
    return (
      <DanceScoreResult
        score={result}
        onRetry={reset}
        onExit={exitToLesson}
        attemptVideoUrl={attemptLocalUrl}
        referenceVideoUrl={dance.video_url ?? null}
      />
    );
  }

  const referenceUrl = dance.video_url;

  return (
    <main className="relative flex h-full w-full flex-col bg-black text-white">
      <header className="safe-top relative z-30 flex h-14 items-center gap-3 px-4">
        <button
          type="button"
          onClick={exitToLesson}
          aria-label="Back to lesson"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/15 active:scale-95"
        >
          <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className="flex-1 text-center">
          <div className="text-[10px] uppercase tracking-widest text-white/50">
            final test
          </div>
          <div className="truncate text-sm font-semibold">{dance.name}</div>
        </div>
        <div className="h-11 w-11" aria-hidden />
      </header>

      {/* Camera fills the available area, mirrored. Same 9/16 aspect
          container as the copy-along's reference panel so the visual
          weight feels consistent across the flow. */}
      <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-black">
        <div className="relative aspect-[9/16] h-full max-h-full w-auto overflow-hidden bg-black">
          <video
            ref={camVideoRef}
            playsInline
            muted
            autoPlay
            className="absolute inset-0 h-full w-full object-cover [transform:scaleX(-1)]"
          />
          {camState !== 'granted' && runState === 'idle' && (
            <CameraPermissionBanner state={camState} onRequest={startCamera} />
          )}
          <div
            aria-hidden
            className="pointer-events-none absolute left-2 top-2 rounded-full bg-black/70 px-2.5 py-1 text-[10px] font-medium uppercase tracking-widest text-coral ring-1 ring-white/10"
          >
            you
          </div>
          {runState === 'recording' && (
            <div className="absolute left-1/2 -translate-x-1/2 top-3 flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 ring-1 ring-white/10">
              <span className="block h-2 w-2 rounded-full bg-coral animate-pulse" />
              <span className="text-[10px] font-bold uppercase tracking-widest">recording</span>
            </div>
          )}
        </div>
      </div>

      {/* Hidden <video> drives the song's audio so we don't need a
          separate <audio> tag and we re-use the reference's embedded
          audio track. Off-screen rather than display:none so the browser
          continues to decode and emit `ended`. */}
      {referenceUrl && (
        <video
          ref={audioVideoRef}
          src={referenceUrl}
          preload="auto"
          playsInline
          onEnded={handleAudioEnded}
          className="pointer-events-none fixed -left-[9999px] top-0 h-1 w-1 opacity-0"
          aria-hidden
        />
      )}

      {runState === 'uploading' && (
        <div className="absolute inset-0 z-40 flex flex-col items-center bg-black/95 backdrop-blur-sm">
          <div className="safe-top w-full px-4 pt-6 text-center">
            <div className="text-[10px] uppercase tracking-[0.22em] text-white/60">
              scoring your dance
            </div>
            <div className="mt-1 text-sm text-white/85">
              this takes 30–60 seconds
            </div>
          </div>
          {/* Side-by-side: the user's just-recorded attempt next to
              the reference, same TikTok-duet layout as the live
              follow-along. Gives them something to watch instead of a
              naked spinner. */}
          {attemptLocalUrl && referenceUrl && (
            <div className="relative flex w-full flex-1 items-center justify-center px-2">
              <div className="flex h-full w-full max-h-[70vh] gap-px bg-black">
                <div className="relative h-full w-1/2 overflow-hidden bg-zinc-950">
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                  <video
                    src={attemptLocalUrl}
                    playsInline
                    muted
                    autoPlay
                    loop
                    className="absolute inset-0 h-full w-full object-contain [transform:scaleX(-1)]"
                  />
                  <span
                    aria-hidden
                    className="pointer-events-none absolute left-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-widest text-coral ring-1 ring-white/10"
                  >
                    you
                  </span>
                </div>
                <div className="relative h-full w-1/2 overflow-hidden bg-black">
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                  <video
                    src={referenceUrl}
                    playsInline
                    muted
                    autoPlay
                    loop
                    className="absolute inset-0 h-full w-full object-contain"
                  />
                  <span
                    aria-hidden
                    className="pointer-events-none absolute left-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-widest text-white ring-1 ring-white/10"
                  >
                    ref
                  </span>
                </div>
              </div>
            </div>
          )}
          <div className="safe-bottom flex w-full items-center justify-center gap-3 px-4 pb-6 pt-3">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            <span className="text-xs uppercase tracking-[0.18em] text-white/75">
              gemini is grading
            </span>
          </div>
        </div>
      )}

      {runState === 'error' && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-black/85 p-6 text-center backdrop-blur-sm">
          <div className="text-2xl font-bold">something went wrong</div>
          <p className="mt-2 max-w-md text-sm text-white/60">{errorMessage}</p>
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

      {runState === 'idle' && (
        <StartOverlay
          chunkNumber={1}
          totalChunks={1}
          chunkLabel={dance.name}
          subtitle="dance to the music — no reference shown"
          skipIdle
          onStart={() => {
            if (camState === 'idle' || camState === 'denied') startCamera();
          }}
          onGo={startRecording}
        />
      )}
    </main>
  );
}

async function uploadAndScore(blob: Blob, referenceUrl: string | null): Promise<DanceScore> {
  if (!referenceUrl) throw new Error('no reference video on this dance');

  // Direct-to-blob upload from the browser. Bypasses Vercel's 4.5MB body
  // limit and keeps the serverless function from spinning while bytes
  // transfer. The token route at /api/upload-token signs the request.
  //
  // Strip the codec suffix from blob.type before passing to upload() —
  // MediaRecorder emits "video/webm;codecs=vp9" but Vercel Blob's
  // allowedContentTypes check is exact-string and rejects the suffix.
  // The codec is preserved inside the bytes themselves, so storage and
  // downstream transcoding both work fine on the base MIME.
  const rawType = blob.type || 'video/webm';
  const contentType = rawType.split(';')[0]!.trim() || 'video/webm';
  const fileName = `attempts/${crypto.randomUUID()}.webm`;
  const uploaded = await upload(fileName, blob, {
    access: 'public',
    handleUploadUrl: '/api/upload-token',
    contentType,
  });

  const res = await fetch('/api/score', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      attemptBlobUrl: uploaded.url,
      attemptContentType: contentType,
      referenceUrl,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`/api/score ${res.status}: ${text || res.statusText}`);
  }
  const payload = (await res.json()) as { score: DanceScore };
  return payload.score;
}
