'use client';

// Tap-to-hear preview. The thumbnail is ALWAYS visible — the play
// button just streams the dance's audio so the user can recognize
// the song. Nothing about the image changes.
//
// Implementation notes:
//
//   - Uses a real <audio> element pointed at the dance's video URL.
//     Browsers strip the video track and play the audio. This avoids
//     the iOS Safari quirk where a <video> element parked offscreen
//     (-9999px) silently refuses to play because it's "not visible."
//
//   - While the audio is playing we render an expanding `animate-ping`
//     ring around the play button so the user can SEE the preview is
//     alive even with the phone on silent.
//
//   - When a different card starts audio, every other instance stops
//     cleanly (no overlap). Implemented via a window-level custom
//     event.

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
  const audioRef = useRef<HTMLAudioElement | null>(null);
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
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.currentTime = 0;
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
      const a = audioRef.current;
      if (!dance.video_url || !a) return;

      if (phase === 'playing' || phase === 'loading') {
        a.pause();
        clearLoadingWatchdog();
        setPhase('idle');
        return;
      }

      window.dispatchEvent(
        new CustomEvent(PREVIEW_EVENT, { detail: { id: instanceIdRef.current } }),
      );
      a.muted = false;
      a.currentTime = 0;
      const playPromise = a.play();
      if (playPromise && typeof playPromise.then === 'function') {
        playPromise
          .then(() => {
            // Safari sometimes resolves play() before firing the
            // 'playing' event. Flip the UI to playing if currentTime
            // is already advancing.
            if (a.currentTime > 0 || !a.paused) {
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
      // Watchdog: if neither the play() promise nor the 'playing'
      // event has put us into 'playing' within 8s, give up and reset
      // so the user isn't staring at a forever-spinner.
      clearLoadingWatchdog();
      loadingTimeoutRef.current = window.setTimeout(() => {
        if (a.paused) {
          setPhase('idle');
        }
      }, 8000);
    },
    [dance.video_url, phase],
  );

  // Stop cleanly when the component unmounts.
  useEffect(() => {
    return () => {
      clearLoadingWatchdog();
      const a = audioRef.current;
      if (a) {
        a.pause();
        a.removeAttribute('src');
        a.load();
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
      <DanceThumb dance={dance} rounded={rounded} className="h-full w-full" />
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        ref={audioRef}
        src={dance.video_url}
        preload="metadata"
        onEnded={() => {
          clearLoadingWatchdog();
          setPhase('idle');
        }}
        onPlaying={() => {
          clearLoadingWatchdog();
          setPhase('playing');
        }}
        onPause={() => {
          const a = audioRef.current;
          if (a && !a.ended) {
            setPhase((p) => (p === 'playing' ? 'idle' : p));
          }
        }}
      />
      {/* The play button — wrapped in a relative span so the
          animate-ping ring can sit BEHIND it without offsetting the
          icon. */}
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
