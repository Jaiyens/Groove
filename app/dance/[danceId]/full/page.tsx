'use client';

// Full-dance copy-along (Mode A++) — TikTok duet layout. The screen is
// split 50/50 vertically: reference choreography on the left, the
// student's mirrored webcam on the right. Both panels are vertical
// portraits that fill their column so the student sees themselves as
// large as the reference, side-by-side, like a TikTok duet.
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
import { useDance } from '@/lib/dances/useDance';
import { attachStream } from '@/lib/pose/cameraAttach';
import { markCameraGranted } from '@/lib/preferences/cameraGrant';
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

  const [rate, setRate] = useState(0.5);
  const loopsAtCurrentRateRef = useRef(0);
  const userChoseSpeedRef = useRef(false);
  const handleSpeedChange = useCallback((next: number) => {
    userChoseSpeedRef.current = true;
    loopsAtCurrentRateRef.current = 0;
    setRate(next);
  }, []);

  const [camState, setCamState] = useState<CamState>('idle');
  // Auto-start: the user reached this page by tapping "Next" on the
  // last chunk, which is gesture enough. Reference video tries autoplay
  // with sound; if iOS blocks it, falls back to muted + tap-to-unmute.
  const [started, setStarted] = useState(true);
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
          onClick={() => router.push(`/dance/${params.danceId}`)}
          aria-label="Back to lesson"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/15 active:scale-95"
        >
          <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className="min-w-0 flex-1 text-center">
          <div className="text-[10px] uppercase tracking-widest text-white/50">
            duet · full dance
          </div>
          <div className="truncate text-sm font-semibold">{dance.name}</div>
        </div>
        <div className="h-11 w-11" aria-hidden />
      </header>

      {/* TikTok duet split: two equal portrait panels filling the screen.
          The reference on the LEFT and the user on the RIGHT mirrors
          TikTok's native duet layout so the comparison reads naturally. */}
      <div className="relative flex flex-1 overflow-hidden bg-black">
        {/* REF panel */}
        <div className="relative h-full w-1/2 overflow-hidden bg-black ring-1 ring-white/5">
          {refSrc ? (
            <video
              ref={refVideoRef}
              src={refSrc}
              playsInline
              preload="auto"
              loop={false}
              onError={() => setRefMissing(true)}
              className={`absolute inset-0 h-full w-full object-cover ${
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
              className="absolute right-2 top-12 z-20 flex h-10 items-center gap-1.5 rounded-full bg-black/85 px-3 text-xs font-semibold text-white ring-1 ring-white/20 active:scale-95"
            >
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 10v4h4l5 5V5L7 10H3z" />
              </svg>
              sound
            </button>
          )}
        </div>

        {/* YOU panel — same dimensions, mirrored. */}
        <div className="relative h-full w-1/2 overflow-hidden bg-zinc-950">
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
            className="pointer-events-none absolute left-2 top-2 rounded-full bg-black/70 px-2.5 py-1 text-[10px] font-medium uppercase tracking-widest text-coral ring-1 ring-white/10"
          >
            you
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
          onClick={() => router.push(`/dance/${params.danceId}/test`)}
          className="ml-auto flex h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full bg-coral px-3 text-sm font-semibold text-white shadow-lg shadow-coral/25 active:scale-[0.98]"
        >
          <span className="truncate">Test</span>
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
            <path d="M5 12h14M13 5l7 7-7 7" />
          </svg>
        </button>
      </div>

    </main>
  );
}
