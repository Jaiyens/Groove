'use client';

// useDanceAudio — hook for playing a reference dance's audio track when the
// reference video isn't being shown (Modes B / C). Source is the same mp4
// file as the reference video; the browser plays the audio track only.
//
// Why a separate <audio> element rather than the existing video element's
// audio: in Mode B / C the video element is unmounted (camera goes full-
// bleed), so we'd lose the audio with it. The hook owns its own element
// attached to the DOM via React's createElement-on-demand pattern would be
// fragile across remounts, so the audio element is allocated lazily and held
// in a ref that persists across renders.

import { useCallback, useEffect, useRef, useState } from 'react';

export interface DanceAudioState {
  isPlaying: boolean;
  isReady: boolean;
  currentTimeMs: number;
  durationMs: number;
  volume: number;
  playbackRate: number;
}

export interface DanceAudioOptions {
  // Defaults to 1.0 (full volume).
  initialVolume?: number;
  // Defaults to 1.0 (normal speed). Mode A uses 0.5–1.0 in the speed toggle.
  initialPlaybackRate?: number;
  // When true, loops the clip. Mode A learning uses this.
  loop?: boolean;
}

export interface DanceAudioController {
  state: DanceAudioState;
  /**
   * Plays from current position. iOS Safari requires this to be invoked from
   * a user gesture handler the first time it runs. Returns true if playback
   * actually started.
   */
  play: () => Promise<boolean>;
  pause: () => void;
  /** Seek to a position in ms. */
  seekMs: (ms: number) => void;
  setVolume: (v: number) => void;
  setPlaybackRate: (r: number) => void;
  /**
   * Suspends playback to the end of the current task. Useful in cleanup.
   */
  stop: () => void;
}

export function useDanceAudio(
  src: string | null,
  options: DanceAudioOptions = {},
): DanceAudioController {
  const {
    initialVolume = 1,
    initialPlaybackRate = 1,
    loop = false,
  } = options;

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [state, setState] = useState<DanceAudioState>({
    isPlaying: false,
    isReady: false,
    currentTimeMs: 0,
    durationMs: 0,
    volume: initialVolume,
    playbackRate: initialPlaybackRate,
  });

  // Lazily allocate the <audio> element on first access. Re-create it when
  // src changes so the browser fully resets buffering and stream state.
  useEffect(() => {
    if (typeof Audio === 'undefined') return;
    if (!src) {
      audioRef.current?.pause();
      audioRef.current = null;
      setState((s) => ({ ...s, isReady: false, isPlaying: false }));
      return;
    }
    const el = new Audio();
    el.src = src;
    el.preload = 'auto';
    el.loop = loop;
    el.volume = clamp01(initialVolume);
    el.playbackRate = initialPlaybackRate;
    el.crossOrigin = 'anonymous';
    audioRef.current = el;

    const onLoaded = () =>
      setState((s) => ({
        ...s,
        isReady: true,
        durationMs: Number.isFinite(el.duration) ? el.duration * 1000 : 0,
      }));
    const onTime = () =>
      setState((s) => ({ ...s, currentTimeMs: el.currentTime * 1000 }));
    const onPlay = () => setState((s) => ({ ...s, isPlaying: true }));
    const onPause = () => setState((s) => ({ ...s, isPlaying: false }));
    const onEnded = () => setState((s) => ({ ...s, isPlaying: false }));
    const onError = () => {
      // mp4 file missing or codec unsupported. Surface via isReady=false so
      // the UI can fall back to a silent practice flow.
      setState((s) => ({ ...s, isReady: false, isPlaying: false }));
    };

    el.addEventListener('loadedmetadata', onLoaded);
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('ended', onEnded);
    el.addEventListener('error', onError);

    return () => {
      el.removeEventListener('loadedmetadata', onLoaded);
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('error', onError);
      el.pause();
      el.src = '';
      if (audioRef.current === el) audioRef.current = null;
    };
  }, [src, loop, initialVolume, initialPlaybackRate]);

  const play = useCallback(async (): Promise<boolean> => {
    const el = audioRef.current;
    if (!el) return false;
    try {
      await el.play();
      return true;
    } catch (err) {
      // Autoplay rejected (iOS) — caller should bind to a user gesture.
      console.warn('audio.play() rejected — needs user gesture', err);
      return false;
    }
  }, []);

  const pause = useCallback(() => {
    audioRef.current?.pause();
  }, []);

  const seekMs = useCallback((ms: number) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, ms / 1000);
  }, []);

  const setVolume = useCallback((v: number) => {
    const clamped = clamp01(v);
    const el = audioRef.current;
    if (el) el.volume = clamped;
    setState((s) => ({ ...s, volume: clamped }));
  }, []);

  const setPlaybackRate = useCallback((r: number) => {
    const safe = clampRate(r);
    const el = audioRef.current;
    if (el) el.playbackRate = safe;
    setState((s) => ({ ...s, playbackRate: safe }));
  }, []);

  const stop = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    el.pause();
    el.currentTime = 0;
  }, []);

  return { state, play, pause, seekMs, setVolume, setPlaybackRate, stop };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function clampRate(x: number): number {
  if (!Number.isFinite(x)) return 1;
  // Browsers throw / fall back for rates outside ~[0.0625, 16]. We clamp tighter.
  if (x < 0.25) return 0.25;
  if (x > 2) return 2;
  return x;
}
