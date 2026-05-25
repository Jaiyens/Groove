'use client';

// Tap-to-hear preview. The thumbnail is ALWAYS visible — a real
// <video> element sits BEHIND the thumbnail so audio plays without
// ever swapping the image, and the browser doesn't throttle it the
// way it does an offscreen/zero-size player.
//
// The click target is the small play button in the corner, NOT the
// whole poster. Keeping it small means there's no ambiguity about
// which element captures the tap and no chance of an absolutely-
// positioned sibling intercepting it.

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
      // Diagnostic — confirms the click reached the handler. Look in
      // DevTools console after tapping. Remove once playback is
      // confirmed working.
      // eslint-disable-next-line no-console
      console.log('[preview]', dance.id, 'tap', phase, 'video=', !!videoRef.current);
      const v = videoRef.current;
      if (!dance.video_url) {
        // eslint-disable-next-line no-console
        console.warn('[preview]', dance.id, 'no video_url on dance');
        return;
      }
      if (!v) {
        // eslint-disable-next-line no-console
        console.warn('[preview]', dance.id, 'video ref not mounted');
        return;
      }

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
      try { v.currentTime = 0; } catch { /* metadata not ready */ }
      setPhase('loading');
      const playPromise = v.play();
      if (playPromise && typeof playPromise.then === 'function') {
        playPromise
          .then(() => {
            // eslint-disable-next-line no-console
            console.log('[preview]', dance.id, 'play() resolved, paused=', v.paused);
            if (!v.paused) {
              clearLoadingWatchdog();
              setPhase('playing');
            }
          })
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.error('[preview]', dance.id, 'play() rejected', err);
            clearLoadingWatchdog();
            setPhase('idle');
          });
      }
      clearLoadingWatchdog();
      loadingTimeoutRef.current = window.setTimeout(() => {
        if (v.paused) {
          // eslint-disable-next-line no-console
          console.warn('[preview]', dance.id, 'watchdog: still paused after 8s');
          setPhase('idle');
        }
      }, 8000);
    },
    [dance.video_url, dance.id, phase],
  );

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

  return (
    <div className={`relative block overflow-hidden ${radius} ${className}`}>
      {dance.video_url && (
        <>
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
            className="pointer-events-none absolute inset-0 h-full w-full object-cover"
          />
        </>
      )}
      <DanceThumb
        dance={dance}
        rounded={rounded}
        className="pointer-events-none relative h-full w-full select-none"
      />
      {/* THE CLICK TARGET — only this button. No ambiguity about which
          element captures the tap. */}
      {dance.video_url && (
        <button
          type="button"
          onClick={handleTap}
          aria-label={
            phase === 'playing'
              ? `pause ${name || 'dance'} audio`
              : `play ${name || 'dance'} audio`
          }
          aria-pressed={phase === 'playing'}
          className="absolute right-2 top-2 z-10 flex h-11 w-11 items-center justify-center"
        >
          {phase === 'playing' && (
            <>
              <span aria-hidden className="absolute inset-2 animate-ping rounded-full bg-coral/70" />
              <span aria-hidden className="absolute inset-1 animate-pulse rounded-full bg-coral/30" />
            </>
          )}
          <span
            aria-hidden
            className={`relative flex h-9 w-9 items-center justify-center rounded-full ring-1 ring-white/15 backdrop-blur-sm ${
              phase === 'playing' ? 'bg-coral text-white' : 'bg-black/70 text-white'
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
        </button>
      )}
    </div>
  );
}
