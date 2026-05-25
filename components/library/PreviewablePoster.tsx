'use client';

// Tap-to-hear preview. The thumbnail is ALWAYS visible — a real
// <video> element sits BEHIND the thumbnail at full card size so
// audio plays without ever swapping the image, and the browser
// doesn't throttle it the way it does an offscreen / zero-size
// player.
//
// Layout:
//   button (relative, overflow-hidden)
//     └ <video> absolute inset-0  — full card, but covered
//     └ <img>   relative h-full   — thumbnail, paints on top
//     └ play button overlay
//
// While playing, an animated coral ring expands around the play
// button (animate-ping) so the user can see the preview is alive
// even with the phone on silent.

import { useCallback, useEffect, useRef, useState } from 'react';
import { displayNameFor, type DanceListItem } from '@/lib/dances/types';
import DanceThumb from './DanceThumb';

interface PreviewablePosterProps {
  dance: Pick<DanceListItem, 'id' | 'title' | 'display_name' | 'thumbnail_url' | 'video_url'>;
  className?: string;
  rounded?: 'lg' | 'xl' | '2xl' | '3xl';
  // Kept for backwards compatibility with callers — ignored.
  autoPlay?: boolean;
}

const PREVIEW_EVENT = 'groove:preview-start';
let previewSeq = 0;

const ROUNDED_CLASS = {
  lg: 'rounded-lg',
  xl: 'rounded-xl',
  '2xl': 'rounded-2xl',
  '3xl': 'rounded-3xl',
} as const;

export default function PreviewablePoster({
  dance,
  className = '',
  rounded = '2xl',
}: PreviewablePosterProps) {
  const [phase, setPhase] = useState<'idle' | 'loading' | 'playing'>('idle');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const loadingTimeoutRef = useRef<number | null>(null);
  const instanceIdRef = useRef<number>(0);
  if (instanceIdRef.current === 0) {
    previewSeq += 1;
    instanceIdRef.current = previewSeq;
  }

  const clearLoadingWatchdog = () => {
    if (loadingTimeoutRef.current !== null) {
      window.clearTimeout(loadingTimeoutRef.current);
      loadingTimeoutRef.current = null;
    }
  };

  const stopMyself = useCallback(() => {
    const v = videoRef.current;
    if (v) {
      v.pause();
      v.currentTime = 0;
    }
    clearLoadingWatchdog();
    setPhase('idle');
  }, []);

  // Listen for sibling previews kicking on; if it's not us, stop.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ id: number }>).detail;
      if (!detail || detail.id === instanceIdRef.current) return;
      stopMyself();
    };
    window.addEventListener(PREVIEW_EVENT, handler);
    return () => window.removeEventListener(PREVIEW_EVENT, handler);
  }, [stopMyself]);

  const handleTap = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const v = videoRef.current;
      if (!dance.video_url || !v) return;

      if (phase === 'playing' || phase === 'loading') {
        v.pause();
        clearLoadingWatchdog();
        setPhase('idle');
        return;
      }

      window.dispatchEvent(
        new CustomEvent(PREVIEW_EVENT, { detail: { id: instanceIdRef.current } }),
      );
      v.muted = false;
      v.volume = 1;
      v.currentTime = 0;
      const playPromise = v.play();
      if (playPromise && typeof playPromise.then === 'function') {
        playPromise
          .then(() => {
            if (v.currentTime > 0 || !v.paused) {
              clearLoadingWatchdog();
              setPhase('playing');
            }
          })
          .catch(() => {
            clearLoadingWatchdog();
            setPhase('idle');
          });
      }
      setPhase('loading');
      clearLoadingWatchdog();
      loadingTimeoutRef.current = window.setTimeout(() => {
        if (v.paused) setPhase('idle');
      }, 8000);
    },
    [dance.video_url, phase],
  );

  // Stop cleanly when the component unmounts.
  useEffect(() => {
    return () => {
      clearLoadingWatchdog();
      const v = videoRef.current;
      if (v) {
        v.pause();
        v.removeAttribute('src');
        v.load();
      }
    };
  }, []);

  const radius = ROUNDED_CLASS[rounded];
  const name = displayNameFor(dance, '');

  if (!dance.video_url) {
    return (
      <div className={`relative block overflow-hidden ${radius} ${className}`}>
        <DanceThumb dance={dance} rounded={rounded} className="h-full w-full" />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={handleTap}
      aria-label={
        phase === 'playing'
          ? `pause ${name || 'dance'} audio`
          : `play ${name || 'dance'} audio`
      }
      aria-pressed={phase === 'playing'}
      className={`relative block overflow-hidden ${radius} ${className}`}
    >
      {/* Video lives underneath the thumbnail — full card size so the
          browser doesn't throttle it (the offscreen / zero-size hack
          made Safari refuse to play). Thumbnail sits on top via DOM
          order. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={videoRef}
        src={dance.video_url}
        playsInline
        preload="metadata"
        onPlaying={() => {
          clearLoadingWatchdog();
          setPhase('playing');
        }}
        onWaiting={() => setPhase((p) => (p === 'playing' ? 'loading' : p))}
        onEnded={() => {
          clearLoadingWatchdog();
          setPhase('idle');
        }}
        onPause={() => {
          const v = videoRef.current;
          if (v && !v.ended) {
            setPhase((p) => (p === 'playing' ? 'idle' : p));
          }
        }}
        className="absolute inset-0 h-full w-full object-cover"
      />
      <DanceThumb
        dance={dance}
        rounded={rounded}
        className="relative h-full w-full"
      />
      {/* Play button + animated ring. */}
      <span
        aria-hidden
        className="pointer-events-none absolute right-2 top-2 flex h-9 w-9 items-center justify-center"
      >
        {phase === 'playing' && (
          <>
            <span className="absolute inset-0 animate-ping rounded-full bg-coral/70" />
            <span className="absolute inset-[-4px] animate-pulse rounded-full bg-coral/30" />
          </>
        )}
        <span
          className={`relative flex h-9 w-9 items-center justify-center rounded-full ring-1 ring-white/15 backdrop-blur-sm ${
            phase === 'playing'
              ? 'bg-coral text-white'
              : 'bg-black/65 text-white'
          }`}
        >
          {phase === 'playing' ? (
            <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="5" width="4" height="14" rx="1" />
              <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
          ) : phase === 'loading' ? (
            <span className="block h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          ) : (
            <svg width={14} height={14} viewBox="0 0 12 12" fill="currentColor">
              <path d="M3 1.5v9l8-4.5z" />
            </svg>
          )}
        </span>
      </span>
    </button>
  );
}
