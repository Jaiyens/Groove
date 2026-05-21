'use client';

// SPECK polish §Fix 6: wraps DanceThumb with a top-right play icon that
// plays the dance video muted + looping for 3 seconds, then snaps back
// to the thumbnail. Tapping the play icon while playing stops it
// immediately. Tap anywhere else on the card continues to behave as
// the parent <Link> intends.
//
// Why this shape:
//   - The <video> element is mounted only after the first tap, so we
//     don't pay the per-card decode cost on library load.
//   - We use a sibling <button> overlaid on top of DanceThumb rather
//     than nesting it inside the parent <Link> — anchors can't contain
//     interactive children per HTML spec. The button uses preventDefault
//     to swallow the click before the link sees it.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DanceListItem } from '@/lib/dances/types';
import DanceThumb from './DanceThumb';

interface PreviewablePosterProps {
  dance: Pick<DanceListItem, 'title' | 'thumbnail_url' | 'video_url'>;
  className?: string;
  rounded?: 'lg' | 'xl' | '2xl' | '3xl';
  // ms the preview plays before snapping back to thumbnail
  durationMs?: number;
}

export default function PreviewablePoster({
  dance,
  className = '',
  rounded = '2xl',
  durationMs = 3000,
}: PreviewablePosterProps) {
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const timerRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    setPlaying(false);
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const v = videoRef.current;
    if (v) {
      v.pause();
      v.currentTime = 0;
    }
  }, []);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const handlePlayTap = useCallback(
    (e: React.MouseEvent) => {
      // Swallow the click so the parent <Link> doesn't navigate.
      e.preventDefault();
      e.stopPropagation();
      if (!dance.video_url) return;
      if (playing) {
        stop();
        return;
      }
      setPlaying(true);
      // Schedule the 3-second snap-back here rather than in useEffect so
      // a manual stop tap doesn't double-fire.
      timerRef.current = window.setTimeout(() => {
        stop();
      }, durationMs);
    },
    [dance.video_url, playing, stop, durationMs],
  );

  const onVideoMounted = useCallback((v: HTMLVideoElement | null) => {
    videoRef.current = v;
    if (v) {
      v.currentTime = 0;
      void v.play().catch(() => {
        /* autoplay-with-audio failed — but we're muted, so this is rare */
      });
    }
  }, []);

  const showPreview = playing && !!dance.video_url;

  return (
    <div className={`relative ${className}`}>
      <DanceThumb
        dance={dance}
        rounded={rounded}
        className={`h-full w-full ${showPreview ? 'invisible' : ''}`}
      />
      {showPreview && (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video
          ref={onVideoMounted}
          src={dance.video_url ?? undefined}
          muted
          loop
          playsInline
          preload="metadata"
          className={`absolute inset-0 h-full w-full object-cover ${
            rounded === 'lg'
              ? 'rounded-lg'
              : rounded === 'xl'
                ? 'rounded-xl'
                : rounded === '3xl'
                  ? 'rounded-3xl'
                  : 'rounded-2xl'
          }`}
        />
      )}
      {dance.video_url && (
        <button
          type="button"
          onClick={handlePlayTap}
          aria-label={playing ? 'stop preview' : 'play preview'}
          aria-pressed={playing}
          className="absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-black/55 text-white ring-1 ring-white/15 backdrop-blur-sm active:scale-95"
        >
          {playing ? (
            <svg width={11} height={11} viewBox="0 0 12 12" fill="currentColor" aria-hidden>
              <rect x="2" y="2" width="3" height="8" rx="0.5" />
              <rect x="7" y="2" width="3" height="8" rx="0.5" />
            </svg>
          ) : (
            <svg width={11} height={11} viewBox="0 0 12 12" fill="currentColor" aria-hidden>
              <path d="M3 1.5v9l8-4.5z" />
            </svg>
          )}
        </button>
      )}
    </div>
  );
}
