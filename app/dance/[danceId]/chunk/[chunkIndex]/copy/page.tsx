'use client';

// Mode A — TikTok Duet copy-along.
//
// Top half:  the real TikTok video plays full-bleed vertical, looping the
//            current chunk at the chosen speed (50/75/100%). Audio comes
//            from this video element — no separate <audio>.
// Bottom half: the user's front-facing camera, mirrored, same vertical
//            aspect ratio. Direct split-screen, not a floating PIP.
//
// Skeleton overlay: small toggle on the reference video. On by default;
// pressing the skeleton button hides it. When on, draws white pose lines
// over the reference using the worker's pose JSON.
//
// Falls back to the legacy skeleton video when video_url is missing (rows
// ingested before Phase 1.1 schema landed). That fallback is silent — the
// rest of the UI looks the same.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import SpeedToggle from '@/components/SpeedToggle';
import SkeletonOverlay from '@/components/SkeletonOverlay';
import StartOverlay from '@/components/StartOverlay';
import CameraPermissionBanner, {
  isInsecureContext,
  type CamState,
} from '@/components/CameraPermissionBanner';
import { useDance } from '@/lib/dances/useDance';
import { recordContinueLearning } from '@/lib/mastery/continueLearning';
import { attachStream } from '@/lib/pose/cameraAttach';
import { isFramingCalibrated } from '@/lib/pose/framingCalibration';
import { PoseExtractor } from '@/lib/pose/poseExtractor';
import { landmarkAt, useReferencePose } from '@/lib/pose/referencePose';
import {
  getMirrorEnabled,
  onMirrorChanged,
  setMirrorEnabled,
} from '@/lib/preferences/mirror';
import type { PoseLandmark } from '@/lib/pose/types';

interface PageProps {
  params: { danceId: string; chunkIndex: string };
}

const SPEED_OPTIONS = [0.5, 0.75, 1] as const;

export default function CopyAlongPage({ params }: PageProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const chunkIndex = Number(params.chunkIndex);
  const { loading, notFound, dance, chunks } = useDance(params.danceId);
  const chunk = chunks[chunkIndex];

  // Drill mode: Mode B's results screen routes the user here with
  // ?from=ms&to=ms&speed=0.5 to focus practice on a 1-2 second window
  // of the chunk the scorer flagged as a trouble spot. We loop that
  // sub-range three times at the requested speed, then auto-advance
  // 0.5 → 0.75 → 1.0, then send the user back to Mode B to re-score
  // just that window. See docs/scoring-rebuild-summary.md.
  const drillFromMs = parseMsParam(searchParams?.get('from'));
  const drillToMs = parseMsParam(searchParams?.get('to'));
  const drillSpeed = parseSpeedParam(searchParams?.get('speed'));
  const isDrillMode = drillFromMs !== null && drillToMs !== null;
  const drillStartMs = isDrillMode && chunk ? Math.max(chunk.startMs, drillFromMs) : null;
  const drillEndMs = isDrillMode && chunk ? Math.min(chunk.endMs, drillToMs) : null;
  const effectiveStartMs = drillStartMs ?? (chunk?.startMs ?? 0);
  const effectiveEndMs = drillEndMs ?? (chunk?.endMs ?? 0);
  // Drill mode loops a tight window 3× per speed tier; track which
  // tier we're on so the auto-advance effect can step through.
  const [drillTier, setDrillTier] = useState(0); // 0 = 0.5x, 1 = 0.75x, 2 = 1.0x
  const drillLoopCountRef = useRef(0);
  const DRILL_TIERS = [0.5, 0.75, 1.0] as const;

  const refVideoRef = useRef<HTMLVideoElement | null>(null);
  const camVideoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const overlayRafRef = useRef<number | null>(null);
  // spec.md round-5 §Fix 3: dual skeleton overlay. The YOU panel runs
  // a live MediaPipe extractor whenever the skeleton toggle is on, in
  // parallel with the REF panel's worker-precomputed track.
  const userExtractorRef = useRef<PoseExtractor | null>(null);
  const userExtractorRafRef = useRef<number | null>(null);

  const [rate, setRate] = useState(() => drillSpeed ?? 0.6);
  const [camState, setCamState] = useState<CamState>('idle');
  const [refMissing, setRefMissing] = useState(false);
  const [showSkeleton, setShowSkeleton] = useState(true);
  // SPECK polish §Fix 2 → overnight Group 2 §mirror-unification: REF
  // mirror state lives in lib/preferences/mirror.ts now so the holding
  // screen REF panel and the Gemini composite read the SAME value. We
  // initialize from the shared getter and subscribe to broadcasts so a
  // toggle elsewhere (e.g. a future settings sheet) reflects here too.
  const [mirrorRef, setMirrorRefState] = useState(getMirrorEnabled);
  useEffect(() => onMirrorChanged(setMirrorRefState), []);
  // Persist + broadcast on every toggle. Replaces the previous local
  // localStorage useEffect.
  const handleToggleMirror = useCallback(() => {
    setMirrorRefState((prev) => {
      const next = !prev;
      setMirrorEnabled(next);
      return next;
    });
  }, []);
  const [muted, setMuted] = useState(false);
  const [needsUnmuteTap, setNeedsUnmuteTap] = useState(false);
  const [refLandmarks, setRefLandmarks] = useState<PoseLandmark[] | null>(null);
  const [userLandmarks, setUserLandmarks] = useState<PoseLandmark[] | null>(null);
  // SPECK round-4 §Fix 2: the reference video does not play until the
  // user taps "start" and the 3-2-1-GO countdown finishes. Re-entering
  // the chunk (back-arrow + tap-in) resets this because the route
  // remounts the page. (The framing-check gate that used to seed this
  // to true was removed in spec.md §Fix 2 — the user is now told to
  // stand back on the setup screen instead.)
  // Drill mode: the user came from a tap on the Mode B results screen,
  // which counts as the "ready" gesture. Skip the start-overlay
  // countdown and roll straight into the looped clip.
  const [started, setStarted] = useState(isDrillMode);

  // Bail if dance / chunk vanish.
  useEffect(() => {
    if (!loading && (notFound || (dance && !chunk))) {
      router.replace(`/dance/${params.danceId}`);
    }
  }, [loading, notFound, dance, chunk, router, params.danceId]);

  useEffect(() => {
    if (typeof window === 'undefined' || isFramingCalibrated()) return;
    // Drill mode arrives from the Mode B results screen with the user
    // already on-camera; redirecting them through the onboarding
    // framing-check would derail the practice loop. The setup screen's
    // standback callout has already done that job.
    if (isDrillMode) return;
    const here = `/dance/${params.danceId}/chunk/${chunkIndex}/copy`;
    router.replace(`/onboarding/frame-check?return=${encodeURIComponent(here)}`);
  }, [params.danceId, chunkIndex, router, isDrillMode]);

  useEffect(() => {
    if (!dance || !chunk || chunks.length === 0) return;
    recordContinueLearning({
      danceId: dance.id,
      title: dance.name,
      displayName: dance.name,
      creatorHandle: dance.artist,
      thumbnailUrl: dance.thumbnail_url,
      totalChunks: chunks.length,
      currentChunkIndex: chunkIndex,
    });
  }, [dance, chunk, chunks.length, chunkIndex]);

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

  // spec.md round-5 §Fix 2: bypass mode (started=true on mount via the
  // framing-gate handoff) needs to kick the camera permission flow
  // itself, since the user never tapped the StartOverlay's start
  // button. Browsers remember the framing-check page's getUserMedia
  // grant for this origin so the call doesn't re-prompt.
  useEffect(() => {
    if (started && camState === 'idle') {
      void startCamera();
    }
    // Run-once intent; subsequent state changes are handled elsewhere.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      if (tMs >= effectiveEndMs || tMs < effectiveStartMs - 50) {
        v.currentTime = effectiveStartMs / 1000;
        if (isDrillMode) {
          drillLoopCountRef.current += 1;
        }
      }
    };
    const seekToStart = () => {
      try {
        v.currentTime = effectiveStartMs / 1000;
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
  }, [chunk, rate, muted, started, effectiveStartMs, effectiveEndMs, isDrillMode]);

  // Drill-mode tier advance. Polls the loop counter every ~500ms and
  // when 3 loops at the current tier have completed, steps up — 0.5x
  // → 0.75x → 1.0x → route to /test page to re-score just this
  // window. Polling instead of event-driven because the underlying
  // loop trigger lives in the video onTimeUpdate callback above.
  useEffect(() => {
    if (!isDrillMode || !chunk || !dance) return;
    const id = window.setInterval(() => {
      if (drillLoopCountRef.current < 3) return;
      drillLoopCountRef.current = 0;
      if (drillTier < DRILL_TIERS.length - 1) {
        const nextTier = drillTier + 1;
        setDrillTier(nextTier);
        setRate(DRILL_TIERS[nextTier]!);
      } else {
        // Done with all 3 tiers — back to Mode B for a re-score on this
        // exact window. We append the drill range so the test page
        // could later scope its scoring to it; today the test page
        // doesn't read those params yet, but the route lands the user
        // in the right place.
        const url = `/dance/${dance.id}/chunk/${chunkIndex}/test?from=${effectiveStartMs}&to=${effectiveEndMs}`;
        router.push(url);
      }
    }, 500);
    return () => window.clearInterval(id);
  }, [
    isDrillMode,
    chunk,
    dance,
    drillTier,
    chunkIndex,
    router,
    effectiveStartMs,
    effectiveEndMs,
  ]);

  // spec.md round-5 §Fix 3: live MediaPipe loop for the YOU panel's
  // skeleton overlay. Only runs while the skeleton toggle is on AND
  // the user camera is granted — keeps the extractor off the critical
  // path of Mode A's normal "watch the reference" flow.
  useEffect(() => {
    if (!showSkeleton || camState !== 'granted') {
      setUserLandmarks(null);
      return;
    }
    let cancelled = false;
    const ex = new PoseExtractor();
    userExtractorRef.current = ex;
    ex.init().catch(() => { /* init failure → skeleton just won't draw */ });
    const tick = () => {
      const v = camVideoRef.current;
      if (v && ex.ready && v.readyState >= 2) {
        const res = ex.detectFromVideo(v, performance.now());
        if (res) setUserLandmarks(res.landmarks);
        else setUserLandmarks(null);
      }
      if (!cancelled) {
        userExtractorRafRef.current = requestAnimationFrame(tick);
      }
    };
    userExtractorRafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (userExtractorRafRef.current !== null) {
        cancelAnimationFrame(userExtractorRafRef.current);
        userExtractorRafRef.current = null;
      }
      ex.close();
      userExtractorRef.current = null;
      setUserLandmarks(null);
    };
  }, [showSkeleton, camState]);

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
      {/* spec.md §Fix 3 hierarchy: compact static header with a 44×44
          back affordance (Apple HIG min tap target). Spacer on the
          right keeps the title visually centred without shifting. */}
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
            copy along · {chunkIndex + 1}/{chunks.length}
          </div>
          <div className="truncate text-sm font-semibold">{chunk.label}</div>
        </div>
        <div className="h-11 w-11" aria-hidden />
      </header>

      {/* spec.md §Fix 3 hierarchy: the reference video is the largest
          element and lives at the top. The user's camera is a fixed
          PiP overlay in the lower-left. The layout is set once on
          entry — conditional UI (CameraPermissionBanner, refMissing,
          needsUnmuteTap) swaps INSIDE its container rather than
          reflowing the parent grid, so nothing jumps mid-dance. */}
      <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-black">
        <div className="relative flex h-full w-full items-center justify-center">
          {/* Reference video — single largest element, 9/16 aspect,
              centered. */}
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
                mirror={mirrorRef}
                edgeColor="#ffffff"
                jointColor="#ffffff"
                staleAfterMs={300}
              />
            )}

            <div
              aria-hidden
              className="pointer-events-none absolute left-2 top-2 rounded-full bg-black/70 px-2.5 py-1 text-[10px] font-medium uppercase tracking-widest text-white ring-1 ring-white/10"
            >
              ref
            </div>

            {/* Drill-mode badge — the user got here from a trouble spot
                on the results screen. Make it visible so they know
                they're in a focused loop, not the normal copy-along. */}
            {isDrillMode && (
              <div
                aria-hidden
                className="pointer-events-none absolute right-2 bottom-2 rounded-full bg-coral/85 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-black ring-1 ring-white/30"
              >
                drill · {drillTier + 1}/3 · {Math.round(DRILL_TIERS[drillTier]! * 100)}%
              </div>
            )}

            {isFallbackToSkeleton && (
              <div className="pointer-events-none absolute right-2 top-2 rounded-full bg-black/70 px-2.5 py-1 text-[10px] font-semibold text-white/80 ring-1 ring-white/10">
                skeleton-only
              </div>
            )}

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

        {/* User camera PiP — fixed slot in the lower-left at ~28%
            of the viewport width. The CameraPermissionBanner +
            "you" tag swap INSIDE this frame, so the parent layout
            never reflows whether the camera is granted or not. */}
        <div className="pointer-events-none absolute bottom-3 left-3 z-10 w-[28%] max-w-[160px]">
          <div className="pointer-events-auto relative aspect-[9/16] overflow-hidden rounded-2xl bg-zinc-950 ring-2 ring-white/20 shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
            <video
              ref={camVideoRef}
              playsInline
              muted
              autoPlay
              className="absolute inset-0 h-full w-full object-cover [transform:scaleX(-1)]"
            />
            {showSkeleton && camState === 'granted' && (
              <SkeletonOverlay
                landmarks={userLandmarks}
                videoRef={camVideoRef}
                mirror
                edgeColor="#ffffff"
                jointColor="#ffffff"
                staleAfterMs={400}
              />
            )}
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

      {/* spec.md §Fix 3 controls: SINGLE row at the bottom, gap-3
          (12 pt) between elements. Every tappable element is h-11
          (44 pt) — meets the Apple HIG minimum tap target. The test
          CTA flexes to fill remaining width so it reads as the
          primary action without breaking the grouping. Exit lives in
          the header so it doesn't compete with the in-experience
          controls here. Duration/speed read-out is dropped — the
          speed pill already shows the active rate. */}
      <div className="safe-bottom relative z-30 flex h-[88px] items-center gap-3 bg-black px-4">
        <SpeedToggle rate={rate} onChange={setRate} options={SPEED_OPTIONS} />
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
          onClick={() => setShowSkeleton((s) => !s)}
          aria-pressed={showSkeleton}
          aria-label={showSkeleton ? 'hide skeleton' : 'show skeleton'}
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ring-1 active:scale-95 ${
            showSkeleton
              ? 'bg-white text-black ring-white'
              : 'bg-white/10 text-white ring-white/15'
          }`}
        >
          <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="5" r="2" />
            <path d="M12 7v5M9 12h6M9 12l-3 7M15 12l3 7" />
          </svg>
        </button>
        {/* spec.md round-5 §Fix 1: button (not Link) so the click
            handler is explicit and traceable. */}
        <button
          type="button"
          onClick={() => router.push(`/dance/${dance.id}/chunk/${chunkIndex}/test`)}
          data-testid="i-got-it-test"
          className="ml-auto flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-coral px-4 text-sm font-semibold text-white shadow-lg shadow-coral/25 active:scale-[0.98]"
        >
          <span>Test</span>
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M5 12h14M13 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* SPECK round-4 §Fix 2: press-start + 3-2-1-GO gate, mounted on
          top of the duet so the user sees the layout behind it.
          Drill mode: skip the gate — the user just came from the Mode B
          results screen and tapping a trouble spot is its own
          "I'm ready" gesture. */}
      {!started && !isDrillMode && (
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

// Drill-mode URL helpers. Kept inside this file because they're tightly
// coupled to the page's drill state machine and have no other callers.

function parseMsParam(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function parseSpeedParam(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n < 0.25 || n > 1.5) return null;
  return n;
}
