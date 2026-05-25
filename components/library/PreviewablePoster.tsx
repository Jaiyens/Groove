'use client';

// Tap-the-card preview with sound.
//
// Behavior:
//   - When `autoPlay` is set, the card silently auto-starts MUTED on mount
//     so the user sees motion immediately (TikTok-discover style). A tap
//     then unmutes and plays from the beginning with audio.
//   - Without autoPlay, the card stays on a still thumbnail. First tap
//     plays with audio; the next tap pauses; the next resumes.
//   - When a DIFFERENT card starts a sounded preview, every other instance
//     stops cleanly (no audio bleed).
//   - The <video> uses `playsInline` so iOS Safari renders inline instead
//     of going fullscreen.
//
// Why the <video> is always mounted (instead of lazy-mounting on tap):
//   iOS Safari only honors autoplay-with-sound when the .play() call
//   happens *synchronously inside* the user-gesture event handler. Lazy-
//   mounting forces .play() to wait for the next React render, which
//   Safari treats as non-gesture and blocks. preload="metadata" keeps the
//   network cost small until tap.
//
// Navigation: this component is no longer the navigation surface. Card
// components wire their own "practice" link separately.

import { useCallback, useEffect, useRef, useState } from 'react';
import { displayNameFor, type DanceListItem } from '@/lib/dances/types';
import DanceThumb from './DanceThumb';

interface PreviewablePosterProps {
  dance: Pick<DanceListItem, 'id' | 'title' | 'display_name' | 'thumbnail_url' | 'video_url'>;
  className?: string;
  rounded?: 'lg' | 'xl' | '2xl' | '3xl';
  // Auto-start muted on mount. Used on the home feed so videos always
  // show motion without requiring a tap. A tap promotes to sounded
  // playback.
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
  autoPlay = false,
}: PreviewablePosterProps) {
  // 'idle'      — nothing started yet, thumbnail showing
  // 'auto'      — silently auto-playing muted (autoPlay only)
  // 'loading'   — user just tapped, buffering for sounded play
  // 'playing'   — playing with sound
  // 'paused'    — user paused after starting a sounded play
  const [phase, setPhase] = useState<'idle' | 'auto' | 'loading' | 'playing' | 'paused'>(
    autoPlay ? 'auto' : 'idle',
  );
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const instanceIdRef = useRef<number>(0);
  if (instanceIdRef.current === 0) {
    previewSeq += 1;
    instanceIdRef.current = previewSeq;
  }

  const stopMyself = useCallback(() => {
    const v = videoRef.current;
    if (v) {
      v.pause();
      v.currentTime = 0;
    }
    setPhase(autoPlay ? 'auto' : 'idle');
  }, [autoPlay]);

  // Listen for sibling previews kicking on; if it's not us, fall back to
  // our quiet auto-state (or fully idle if we don't auto-play).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ id: number }>).detail;
      if (!detail || detail.id === instanceIdRef.current) return;
      // Only stop if WE were the sounded one — don't kill quiet auto-loops.
      const v = videoRef.current;
      if (!v) return;
      if (!v.muted) stopMyself();
    };
    window.addEventListener(PREVIEW_EVENT, handler);
    return () => window.removeEventListener(PREVIEW_EVENT, handler);
  }, [stopMyself]);

  // Kick the muted auto-play loop as soon as the element is ready.
  useEffect(() => {
    if (!autoPlay || !dance.video_url) return;
    const v = videoRef.current;
    if (!v) return;
    v.muted = true;
    v.loop = true;
    const tryAutoPlay = () => {
      v.play().catch(() => {
        // Muted autoplay shouldn't fail in modern browsers, but if it
        // does we fall back to idle and the user can tap to start.
        setPhase('idle');
      });
    };
    if (v.readyState >= 2) tryAutoPlay();
    else {
      const onCanPlay = () => {
        tryAutoPlay();
        v.removeEventListener('canplay', onCanPlay);
      };
      v.addEventListener('canplay', onCanPlay);
      try { v.load(); } catch { /* ignore */ }
    }
  }, [autoPlay, dance.video_url]);

  const handleTap = useCallback(() => {
    const v = videoRef.current;
    if (!dance.video_url || !v) return;

    if (phase === 'playing') {
      v.pause();
      setPhase('paused');
      return;
    }

    // Either resuming from paused or kicking off the first sounded play.
    // Either way: dispatch the stop-others event and call .play()
    // synchronously inside this click so Safari honors the gesture.
    window.dispatchEvent(
      new CustomEvent(PREVIEW_EVENT, { detail: { id: instanceIdRef.current } }),
    );
    // Promote from auto/idle to sounded playback.
    if (phase === 'auto' || phase === 'idle') {
      v.muted = false;
      v.loop = false;
      v.currentTime = 0;
    } else if (phase === 'paused') {
      v.muted = false;
    }
    const playPromise = v.play();
    if (playPromise && typeof playPromise.then === 'function') {
      playPromise.catch(() => {
        // Safari can reject if it decides the gesture didn't apply.
        // Fall back to whichever quiet state we came from.
        setPhase(autoPlay ? 'auto' : 'idle');
      });
    }
    setPhase('loading');
  }, [dance.video_url, phase, autoPlay]);

  // Stop cleanly when the component unmounts (e.g. user navigates away).
  // iOS holds the audio session until the element is cleared.
  useEffect(() => {
    return () => {
      const v = videoRef.current;
      if (v) {
        v.pause();
        v.removeAttribute('src');
        v.load();
      }
    };
  }, []);

  const radius = ROUNDED_CLASS[rounded];
  // Hide the thumbnail whenever the video element is visibly painting frames.
  const showVideo =
    (phase === 'auto' || phase === 'loading' || phase === 'playing' || phase === 'paused') &&
    !!dance.video_url;
  const name = displayNameFor(dance, '');

  return (
    <button
      type="button"
      onClick={handleTap}
      aria-label={
        phase === 'playing'
          ? `pause ${name || 'dance'} preview`
          : `play ${name || 'dance'} preview`
      }
      aria-pressed={phase === 'playing'}
      className={`relative block overflow-hidden ${radius} ${className}`}
    >
      <DanceThumb
        dance={dance}
        rounded={rounded}
        className={`h-full w-full ${showVideo ? 'invisible' : ''}`}
      />
      {dance.video_url && (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video
          ref={videoRef}
          src={dance.video_url}
          // Initial autoplay loop is silent; tap promotes to sound.
          // Without autoPlay, audio kicks on first user tap.
          muted={autoPlay && phase !== 'playing' && phase !== 'loading' && phase !== 'paused'}
          loop={autoPlay && (phase === 'auto')}
          playsInline
          preload="metadata"
          onEnded={() => setPhase(autoPlay ? 'auto' : 'idle')}
          onPlaying={() => setPhase((p) => (p === 'auto' ? 'auto' : 'playing'))}
          onWaiting={() =>
            setPhase((p) => (p === 'playing' ? 'loading' : p))
          }
          onPause={() => {
            const v = videoRef.current;
            if (v && !v.ended) {
              setPhase((p) => (p === 'playing' ? 'paused' : p));
            }
          }}
          className={`absolute inset-0 h-full w-full object-cover ${radius} ${
            showVideo ? '' : 'invisible'
          }`}
        />
      )}
      {phase === 'loading' && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40"
        >
          <span className="block h-7 w-7 animate-spin rounded-full border-2 border-white/30 border-t-white" />
        </span>
      )}
      {/* Sound affordance: visible in auto/idle states so the user knows
          tapping promotes to sound. Muted icon when looping silently. */}
      {dance.video_url && (phase === 'auto' || phase === 'idle') && (
        <span
          aria-hidden
          className="pointer-events-none absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white ring-1 ring-white/15 backdrop-blur-sm"
        >
          {phase === 'auto' ? (
            // muted-speaker glyph
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M11 5L6 9H3v6h3l5 4V5z" />
              <line x1="22" y1="9" x2="16" y2="15" />
              <line x1="16" y1="9" x2="22" y2="15" />
            </svg>
          ) : (
            <svg width={14} height={14} viewBox="0 0 12 12" fill="currentColor" aria-hidden>
              <path d="M3 1.5v9l8-4.5z" />
            </svg>
          )}
        </span>
      )}
    </button>
  );
}
