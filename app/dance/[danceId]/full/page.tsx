'use client';

// Full-dance copy-along (Mode A++): same TikTok-duet layout as the chunk
// copy-along — reference video full-bleed, user webcam in a small bottom-
// left PiP — but playing the entire routine instead of a single chunk
// window. No Gemini scoring here; this is the step where the user
// rehearses the whole dance once before taking the actual test.
//
// Speed progression mirrors the chunk copy page: starts at 0.5x, auto-
// bumps to 0.75x after 2 loops, then to 1.0x after 2 more, then sticks
// at 1.0x. Manual speed selection turns auto-progression off.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import CameraPermissionBanner, {
  type CamState,
} from '@/components/CameraPermissionBanner';
import SpeedToggle from '@/components/SpeedToggle';
import StartOverlay from '@/components/StartOverlay';
import { useDance } from '@/lib/dances/useDance';
import { attachStream } from '@/lib/pose/cameraAttach';
import {
  getMirrorEnabled,
  onMirrorChanged,
  setMirrorEnabled,
} from '@/lib/preferences/mirror';

const SPEED_OPTIONS = [0.5, 0.75, 1] as const;

interface PageProps {
  params: { danceId: string };
}

export default function FullCopyAlongPage({ params }: PageProps) {
  const router = useRouter();
  const { loading, notFound, dance } = useDance(params.danceId);

  useEffect(() => {
    if (!loading && notFound) router.replace('/');
  }, [loading, notFound, router]);

  const refVideoRef = useRef<HTMLVideoElement | null>(null);
  const camVideoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Auto-progression state. Same rules as the chunk copy page so the
  // experience feels continuous.
  const [rate, setRate] = useState(0.5);
  const loopsAtCurrentRateRef = useRef(0);
  const userChoseSpeedRef = useRef(false);
  const handleSpeedChange = useCallback((next: number) => {
    userChoseSpeedRef.current = true;
    loopsAtCurrentRateRef.current = 0;
    setRate(next);
  }, []);

  const [camState, setCamState] = useState<CamState>('idle');
  const [started, setStarted] = useState(false);
  const [muted, setMuted] = useState(false);
  const [needsUnmuteTap, setNeedsUnmuteTap] = useState(false);
  const [refMissing, setRefMissing] = useState(false);
  const [mirrorRef, setMirrorRefState] = useState(getMirrorEnabled);
  useEffect(() => onMirrorChanged(setMirrorRefState), []);
  const handleToggleMirror = useCallback(() => {
    setMirrorRefState((prev) => {
      const next = !prev;
      setMirrorEnabled(next);
      return next;
    });
  }, []);

  // Camera setup. Same flow as the chunk copy page.
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
      setCamState(playing ? 'granted' : 'needs_tap');
    } catch {
      setCamState('denied');
    }
  }, []);

  useEffect(() => {
    if (camState === 'idle' && !loading && dance) startCamera();
  }, [camState, loading, dance, startCamera]);

  // Reference video chunk loop — full dance window.
  useEffect(() => {
    const v = refVideoRef.current;
    if (!v || !dance) return;
    const durationMs = dance.duration_seconds * 1000;
    v.playbackRate = rate;
    v.muted = muted;

    const onTimeUpdate = () => {
      if (!started) return;
      const tMs = v.currentTime * 1000;
      if (tMs >= durationMs) {
        v.currentTime = 0;
        if (userChoseSpeedRef.current) return;
        loopsAtCurrentRateRef.current += 1;
        if (loopsAtCurrentRateRef.current < 2) return;
        loopsAtCurrentRateRef.current = 0;
        if (rate < 0.75) setRate(0.75);
        else if (rate < 1) setRate(1);
      }
    };
    const seekToStart = () => {
      try {
        v.currentTime = 0;
        v.playbackRate = rate;
      } catch {
        /* metadata not ready */
      }
    };
    const tryPlay = () => {
      if (!started) return;
      v.play().catch((err: unknown) => {
        const name = (err as { name?: string } | null)?.name;
        if (name === 'NotAllowedError' && !v.muted) {
          v.muted = true;
          setMuted(true);
          setNeedsUnmuteTap(true);
          void v.play().catch(() => {});
        }
      });
    };
    const onLoadedMeta = () => {
      seekToStart();
      tryPlay();
    };
    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('loadedmetadata', onLoadedMeta);
    if (v.readyState >= 1) {
      seekToStart();
      tryPlay();
    } else if (!started) {
      try { v.load(); } catch { /* ignore */ }
    }
    return () => {
      v.removeEventListener('timeupdate', onTimeUpdate);
      v.removeEventListener('loadedmetadata', onLoadedMeta);
    };
  }, [dance, rate, muted, started]);

  const handleUnmuteTap = useCallback(() => {
    const v = refVideoRef.current;
    if (!v) return;
    v.muted = false;
    setMuted(false);
    setNeedsUnmuteTap(false);
    void v.play().catch(() => {});
  }, []);

  const handleOverlayStart = useCallback(() => {
    if (camState === 'idle' || camState === 'denied') startCamera();
  }, [camState, startCamera]);

  const handleOverlayGo = useCallback(() => {
    setStarted(true);
  }, []);

  // Cleanup on unmount.
  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    },
    [],
  );

  if (loading || !dance) {
    return (
      <main className="flex h-full items-center justify-center bg-black text-white/60">
        Loading…
      </main>
    );
  }

  const refSrc = dance.video_url;

  return (
    <main className="relative flex h-full w-full flex-col bg-black text-white">
      <header className="safe-top relative z-30 flex h-14 items-center gap-3 px-4">
        <button
          type="button"
          onClick={() => router.push(`/dance/${dance.id}`)}
          aria-label="Back to lesson"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/15 active:scale-95"
        >
          <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className="flex-1 text-center">
          <div className="text-[10px] uppercase tracking-widest text-white/50">
            full dance · copy along
          </div>
          <div className="truncate text-sm font-semibold">{dance.name}</div>
        </div>
        <div className="h-11 w-11" aria-hidden />
      </header>

      <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-black">
        <div className="relative flex h-full w-full items-center justify-center">
          {/* Reference video — single largest element, 9/16 aspect, centered. */}
          <div className="relative aspect-[9/16] h-full max-h-full w-auto overflow-hidden bg-black">
            {refSrc ? (
              <video
                ref={refVideoRef}
                src={refSrc}
                playsInline
                preload="auto"
                loop={false}
                onError={() => setRefMissing(true)}
                className={`absolute inset-0 h-full w-full object-contain ${
                  mirrorRef ? '[transform:scaleX(-1)]' : ''
                }`}
                aria-label={`${dance.name} reference`}
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-white/50">
                reference video unavailable
              </div>
            )}

            {refMissing && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-br from-black to-zinc-900 p-6 text-center">
                <div className="text-xs uppercase tracking-widest text-white/70">
                  reference video unavailable
                </div>
              </div>
            )}

            <div
              aria-hidden
              className="pointer-events-none absolute left-2 top-2 rounded-full bg-black/70 px-2.5 py-1 text-[10px] font-medium uppercase tracking-widest text-white ring-1 ring-white/10"
            >
              ref
            </div>

            {needsUnmuteTap && (
              <button
                type="button"
                onClick={handleUnmuteTap}
                aria-label="tap for sound"
                className="absolute right-3 top-12 z-20 flex h-11 items-center gap-1.5 rounded-full bg-black/85 px-3.5 text-xs font-semibold text-white ring-1 ring-white/20 active:scale-95"
              >
                <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M3 10v4h4l5 5V5L7 10H3z" />
                </svg>
                tap for sound
              </button>
            )}
          </div>
        </div>

        {/* User camera PiP — fixed slot in the lower-left at ~28% of the
            viewport width. Same aspect-[9/16] container as the reference
            so both panels read as matched portrait videos. */}
        <div className="pointer-events-none absolute bottom-3 left-3 z-10 w-[28%] max-w-[160px]">
          <div className="pointer-events-auto relative aspect-[9/16] overflow-hidden rounded-2xl bg-zinc-950 ring-2 ring-white/20 shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
            <video
              ref={camVideoRef}
              playsInline
              muted
              autoPlay
              className="absolute inset-0 h-full w-full object-cover [transform:scaleX(-1)]"
            />
            {camState !== 'granted' && (
              <CameraPermissionBanner
                state={camState}
                onRequest={startCamera}
                compact
              />
            )}
            <div
              aria-hidden
              className="pointer-events-none absolute left-1.5 top-1.5 rounded-full bg-black/70 px-2 py-0.5 text-[9px] font-medium uppercase tracking-widest text-coral ring-1 ring-white/10"
            >
              you
            </div>
          </div>
        </div>
      </div>

      <div className="safe-bottom relative z-30 flex h-[88px] items-center gap-3 bg-black px-4">
        <SpeedToggle rate={rate} onChange={handleSpeedChange} options={SPEED_OPTIONS} />
        <button
          type="button"
          onClick={handleToggleMirror}
          aria-pressed={mirrorRef}
          aria-label={mirrorRef ? 'unmirror reference' : 'mirror reference'}
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ring-1 active:scale-95 ${
            mirrorRef
              ? 'bg-white text-black ring-white'
              : 'bg-white/10 text-white ring-white/15'
          }`}
        >
          <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 3v18" />
            <path d="M8 7L4 12l4 5" />
            <path d="M16 7l4 5-4 5" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => router.push(`/dance/${dance.id}/test`)}
          className="ml-auto flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-coral px-4 text-sm font-semibold text-white shadow-lg shadow-coral/25 active:scale-[0.98]"
        >
          <span>Take the test</span>
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M5 12h14M13 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {!started && (
        <StartOverlay
          chunkNumber={1}
          totalChunks={1}
          chunkLabel={dance.name}
          subtitle="dance the whole routine"
          onStart={handleOverlayStart}
          onGo={handleOverlayGo}
        />
      )}
    </main>
  );
}
