'use client';

// Mode A — TikTok Duet copy-along.
//
// Top half:  the real TikTok video plays full-bleed vertical, looping the
//            current chunk at the chosen speed (50/75/100%). Audio comes
//            from this video element — no separate <audio>.
// Bottom half: the user's front-facing camera, mirrored, same vertical
//            aspect ratio. Direct split-screen, not a floating PIP.
//
// Skeleton overlay: small toggle on the reference video. Off by default
// (user wants to see Charli's actual body). When on, draws white pose
// lines over the reference using the worker's pose JSON.
//
// Falls back to the legacy skeleton video when video_url is missing (rows
// ingested before Phase 1.1 schema landed). That fallback is silent — the
// rest of the UI looks the same.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import SpeedToggle from '@/components/SpeedToggle';
import SkeletonOverlay from '@/components/SkeletonOverlay';
import StartOverlay from '@/components/StartOverlay';
import CameraPermissionBanner, {
  isInsecureContext,
  type CamState,
} from '@/components/CameraPermissionBanner';
import { useDance } from '@/lib/dances/useDance';
import { attachStream } from '@/lib/pose/cameraAttach';
import { landmarkAt, useReferencePose } from '@/lib/pose/referencePose';
import type { PoseLandmark } from '@/lib/pose/types';

interface PageProps {
  params: { danceId: string; chunkIndex: string };
}

const SPEED_OPTIONS = [0.5, 0.75, 1] as const;

export default function CopyAlongPage({ params }: PageProps) {
  const router = useRouter();
  const chunkIndex = Number(params.chunkIndex);
  const { loading, notFound, dance, chunks } = useDance(params.danceId);
  const chunk = chunks[chunkIndex];

  const refVideoRef = useRef<HTMLVideoElement | null>(null);
  const camVideoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const overlayRafRef = useRef<number | null>(null);

  const [rate, setRate] = useState(0.6);
  const [camState, setCamState] = useState<CamState>('idle');
  const [refMissing, setRefMissing] = useState(false);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [muted, setMuted] = useState(false);
  const [needsUnmuteTap, setNeedsUnmuteTap] = useState(false);
  const [refLandmarks, setRefLandmarks] = useState<PoseLandmark[] | null>(null);
  // SPECK round-4 §Fix 2: the reference video does not play until the
  // user taps "start" and the 3-2-1-GO countdown finishes. Re-entering
  // the chunk (back-arrow + tap-in) resets this because the route
  // remounts the page.
  const [started, setStarted] = useState(false);

  // Bail if dance / chunk vanish.
  useEffect(() => {
    if (!loading && (notFound || (dance && !chunk))) {
      router.replace(`/dance/${params.danceId}`);
    }
  }, [loading, notFound, dance, chunk, router, params.danceId]);

  // Reference media: prefer the real TikTok video, fall back to the
  // skeleton-only mp4 for legacy rows whose video_url is null.
  const refSrc =
    dance?.video_url ?? dance?.skeleton_video_url ?? undefined;
  const isFallbackToSkeleton =
    !dance?.video_url && !!dance?.skeleton_video_url;

  // Skeleton overlay data — only fetched when the toggle is on.
  const { data: poseData } = useReferencePose(
    showSkeleton ? dance?.pose_data_url : null,
  );

  // Camera attach. Triggered by user tap so iOS Safari treats it as a gesture
  // (autoplay-with-sound + getUserMedia both need that).
  const startCamera = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setCamState(isInsecureContext() ? 'insecure' : 'unavailable');
      return;
    }
    if (isInsecureContext()) {
      setCamState('insecure');
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
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setCamState('denied');
      } else {
        setCamState('unavailable');
      }
    }
  }, []);

  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (overlayRafRef.current !== null) {
        cancelAnimationFrame(overlayRafRef.current);
      }
    },
    [],
  );

  // Reference-video chunk loop. Drives video playback within [startMs, endMs]
  // at the chosen rate. Audio is the video's own audio track. Gated on
  // `started` (SPECK round-4 §Fix 2): the video stays paused at the chunk's
  // start frame until the user has tapped "start" and the 3-2-1 has fired.
  useEffect(() => {
    const v = refVideoRef.current;
    if (!v || !chunk) return;
    v.playbackRate = rate;
    v.muted = muted;

    const onTimeUpdate = () => {
      if (!started) return;
      const tMs = v.currentTime * 1000;
      if (tMs >= chunk.endMs || tMs < chunk.startMs - 50) {
        v.currentTime = chunk.startMs / 1000;
      }
    };
    const seekToStart = () => {
      try {
        v.currentTime = chunk.startMs / 1000;
        v.playbackRate = rate;
      } catch {
        /* ignore — happens if the seek runs before metadata is ready */
      }
    };
    const tryPlay = () => {
      if (!started) return;
      v.play().catch((err: unknown) => {
        // Autoplay-with-sound blocked. Mute + retry; surface unmute prompt.
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
      // Still want the first frame visible behind the overlay so the
      // user can see what they're about to dance — kick a load.
      try { v.load(); } catch { /* ignore */ }
    }
    return () => {
      v.removeEventListener('timeupdate', onTimeUpdate);
      v.removeEventListener('loadedmetadata', onLoadedMeta);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunk, rate, muted, started]);

  // Drive the skeleton overlay's landmark state from the reference video's
  // currentTime. Cheap (binary search per frame), only runs while the toggle
  // is on and pose data has loaded.
  useEffect(() => {
    if (!showSkeleton || !poseData) {
      setRefLandmarks(null);
      return;
    }
    const tick = () => {
      const v = refVideoRef.current;
      if (v) {
        const tMs = v.currentTime * 1000;
        setRefLandmarks(landmarkAt(poseData, tMs));
      }
      overlayRafRef.current = requestAnimationFrame(tick);
    };
    overlayRafRef.current = requestAnimationFrame(tick);
    return () => {
      if (overlayRafRef.current !== null) {
        cancelAnimationFrame(overlayRafRef.current);
        overlayRafRef.current = null;
      }
    };
  }, [showSkeleton, poseData]);

  // Pause when the tab is hidden so audio doesn't keep going in the
  // background; resume when it returns — but only if the user has
  // already crossed the StartOverlay gate.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVis = () => {
      const v = refVideoRef.current;
      if (!v) return;
      if (document.hidden) v.pause();
      else if (started) void v.play().catch(() => {});
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [started]);

  const handleUnmuteTap = useCallback(() => {
    const v = refVideoRef.current;
    if (!v) return;
    v.muted = false;
    setMuted(false);
    setNeedsUnmuteTap(false);
    void v.play().catch(() => {});
  }, []);

  // SPECK round-4 §Fix 2: StartOverlay fires this when the user taps
  // "start". One gesture covers iOS Safari's autoplay-with-sound +
  // getUserMedia permission. The video is still gated on `started`
  // (the GO callback) so this only PREPARES playback; it doesn't start.
  const handleOverlayStart = useCallback(() => {
    const v = refVideoRef.current;
    if (v && v.muted) {
      v.muted = false;
      setMuted(false);
      setNeedsUnmuteTap(false);
    }
    if (camState === 'idle' || camState === 'needs_tap' || camState === 'denied') {
      void startCamera();
    }
  }, [camState, startCamera]);

  const handleOverlayGo = useCallback(() => {
    setStarted(true);
  }, []);

  const chunkDurationSec = useMemo(
    () => (chunk ? (chunk.endMs - chunk.startMs) / 1000 : 0),
    [chunk],
  );

  if (loading || !dance || !chunk) {
    return (
      <main className="flex h-full items-center justify-center bg-black text-white/60">
        Loading…
      </main>
    );
  }

  return (
    <main className="relative flex h-full w-full flex-col bg-black text-white">
      <header className="safe-top relative z-30 flex items-center gap-3 px-4 pt-3 pb-2">
        <button
          type="button"
          onClick={() => router.back()}
          aria-label="Back"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/15 active:scale-95"
        >
          <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className="flex-1 text-center">
          <div className="text-[10px] uppercase tracking-widest text-white/50">
            copy along · {chunkIndex + 1}/{chunks.length}
          </div>
          <div className="truncate text-sm font-semibold">{chunk.label}</div>
        </div>
        <button
          type="button"
          onClick={() => setShowSkeleton((s) => !s)}
          aria-pressed={showSkeleton}
          aria-label={showSkeleton ? 'hide skeleton' : 'show skeleton'}
          className={`flex h-10 items-center gap-1.5 rounded-full px-3 ring-1 active:scale-95 ${
            showSkeleton
              ? 'bg-white text-black ring-white'
              : 'bg-white/10 text-white ring-white/15'
          }`}
        >
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="5" r="2" />
            <path d="M12 7v5M9 12h6M9 12l-3 7M15 12l3 7" />
          </svg>
          <span className="text-xs font-semibold">skeleton</span>
        </button>
      </header>

      {/* Duet: TikTok-style split-screen. Side-by-side on phones
          (reference left, user camera right). Falls back to vertical
          stack on tiny viewports (<400 px) where 200 px per column
          would be too narrow to read — SPECK rev 3 §Issue 3. */}
      <div className="relative flex flex-1 flex-row max-[399px]:flex-col overflow-hidden">
        {/* Left: reference video */}
        <div className="relative flex-1 overflow-hidden bg-black">
          {refSrc ? (
            <video
              ref={refVideoRef}
              src={refSrc}
              playsInline
              preload="auto"
              loop={false}
              onError={() => setRefMissing(true)}
              className="absolute inset-0 h-full w-full object-cover"
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
              <p className="mt-2 max-w-xs text-sm text-white/60">
                the worker hasn’t finished rendering this dance. try going
                back and resubmitting.
              </p>
            </div>
          )}

          {showSkeleton && refSrc && !refMissing && (
            <SkeletonOverlay
              landmarks={refLandmarks}
              videoRef={refVideoRef}
              mirror={false}
              edgeColor="#ffffff"
              jointColor="#ffffff"
              staleAfterMs={300}
            />
          )}

          {isFallbackToSkeleton && (
            <div className="pointer-events-none absolute left-3 top-3 z-10 rounded-full bg-black/70 px-2.5 py-1 text-[10px] font-semibold text-white/80 ring-1 ring-white/10">
              fallback: skeleton-only
            </div>
          )}

          {needsUnmuteTap && (
            <button
              type="button"
              onClick={handleUnmuteTap}
              className="absolute right-3 top-3 z-20 flex items-center gap-1.5 rounded-full bg-black/80 px-3 py-1.5 text-xs font-semibold text-white ring-1 ring-white/20 active:scale-95"
            >
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 10v4h4l5 5V5L7 10H3z" />
              </svg>
              tap for sound
            </button>
          )}
        </div>

        {/* Divider — vertical in side-by-side, horizontal in stacked fallback. */}
        <div
          aria-hidden
          className="w-px h-full bg-white/15 max-[399px]:h-px max-[399px]:w-full"
        />

        {/* Right: user camera */}
        <div className="relative flex-1 overflow-hidden bg-zinc-950">
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
            className="pointer-events-none absolute left-3 top-3 rounded-full bg-black/70 px-2.5 py-1 text-[10px] font-medium uppercase tracking-widest text-coral ring-1 ring-white/10"
          >
            you
          </div>
        </div>
      </div>

      <div className="safe-bottom relative z-30 flex flex-col gap-3 bg-black px-4 pt-3 pb-4">
        <div className="flex items-center justify-between">
          <SpeedToggle rate={rate} onChange={setRate} options={SPEED_OPTIONS} />
          <div className="text-right text-[11px] text-white/50">
            <div>{chunkDurationSec.toFixed(1)}s · {Math.round(rate * 100)}%</div>
            <div>{chunks.length} chunks</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/dance/${dance.id}`}
            className="flex-1 rounded-full bg-white/10 py-3 text-center text-sm font-semibold text-white ring-1 ring-white/15 active:scale-[0.98]"
          >
            back to lesson
          </Link>
          <Link
            href={`/dance/${dance.id}/chunk/${chunkIndex}/test`}
            className="flex-[2] rounded-full bg-coral py-3 text-center text-sm font-semibold text-white active:scale-[0.98]"
          >
            I got it · test
          </Link>
        </div>
      </div>

      {/* SPECK round-4 §Fix 2: press-start + 3-2-1-GO gate, mounted on
          top of the duet so the user sees the layout behind it. */}
      {!started && (
        <StartOverlay
          chunkNumber={chunkIndex + 1}
          totalChunks={chunks.length}
          chunkLabel={chunk.label ?? `section ${chunkIndex + 1}`}
          subtitle="watch first, then copy"
          onStart={handleOverlayStart}
          onGo={handleOverlayGo}
        />
      )}
    </main>
  );
}
