'use client';

// SPECK §Fix 1: tap-the-card preview with sound.
//
// Previous behavior (the bug the spec was filed against): a small play
// icon triggered a 3-second muted looping preview that snapped back
// to a static thumbnail. People recognize TikTok dances by the song,
// so a silent 3-second preview made the library unusable.
//
// New behavior:
//   - Tapping the thumbnail starts the reference video with audio.
//     The autoplay-with-sound is allowed because .play() is called
//     synchronously inside the click handler.
//   - Plays continuously through the whole reference clip; no auto-
//     stop, no loop.
//   - Tap again → pause. Tap again → resume.
//   - When a DIFFERENT card starts a preview, this one stops cleanly
//     (no audio bleed). Implemented via a window-level custom event;
//     each instance listens, the originator skips its own event.
//   - The <video> uses `playsInline` so iOS Safari renders inline
//     instead of going fullscreen. It is NOT `muted`.
//
// Why the <video> is always mounted (instead of lazy-mounting on tap):
//   iOS Safari only honors autoplay-with-sound when the .play() call
//   happens *synchronously inside* the user-gesture event handler.
//   Lazy-mounting forces .play() to wait for the next React render,
//   which Safari interprets as a non-gesture programmatic play and
//   blocks. preload="none" keeps the network cost zero until tap.
//
// Navigation: this component is no longer the navigation surface.
// Card components wire their own "practice" link separately.

import { useCallback, useEffect, useRef, useState } from 'react';
import { displayNameFor, type DanceListItem } from '@/lib/dances/types';
import DanceThumb from './DanceThumb';

interface PreviewablePosterProps {
  dance: Pick<DanceListItem, 'id' | 'title' | 'display_name' | 'thumbnail_url' | 'video_url'>;
  className?: string;
  rounded?: 'lg' | 'xl' | '2xl' | '3xl';
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
  const [phase, setPhase] = useState<'idle' | 'playing' | 'paused'>('idle');
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

  const handleTap = useCallback(() => {
    const v = videoRef.current;
    if (!dance.video_url || !v) return;

    if (phase === 'playing') {
      v.pause();
      setPhase('paused');
      return;
    }

    // Either resuming from paused or kicking off the first play.
    // Either way: dispatch the stop-others event and call .play()
    // synchronously inside this click so Safari honors the gesture.
    window.dispatchEvent(
      new CustomEvent(PREVIEW_EVENT, { detail: { id: instanceIdRef.current } }),
    );
    if (phase === 'idle') {
      v.currentTime = 0;
    }
    const playPromise = v.play();
    if (playPromise && typeof playPromise.then === 'function') {
      playPromise.catch(() => {
        // Safari can reject if it decides the gesture didn't apply.
        // Leave the state as 'idle' so the user can re-tap.
        setPhase('idle');
      });
    }
    setPhase('playing');
  }, [dance.video_url, phase]);

  // Stop cleanly when the component unmounts (e.g. user navigates
  // away). iOS holds the audio session until the element is cleared.
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
  const showVideo = phase !== 'idle' && !!dance.video_url;
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
          // Not muted: audio is the point — TikTok dances are
          // recognized by the song.
          playsInline
          preload="none"
          onEnded={() => setPhase('idle')}
          onPause={() => {
            // Sync state if the underlying media pauses for reasons
            // other than our handler (e.g. iOS interrupt). Don't
            // touch state when the video actually ended.
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
      {dance.video_url && phase === 'idle' && (
        <span
          aria-hidden
          className="pointer-events-none absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white ring-1 ring-white/15 backdrop-blur-sm"
        >
          <svg width={14} height={14} viewBox="0 0 12 12" fill="currentColor" aria-hidden>
            <path d="M3 1.5v9l8-4.5z" />
          </svg>
        </span>
      )}
    </button>
  );
}
