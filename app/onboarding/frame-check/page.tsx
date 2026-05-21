'use client';

// One-time framing calibration (SPECK §4 onboarding).
//
// Shows the camera full-screen with a translucent body silhouette.
// Detects pose every frame; when all 17 "skeleton" joints have been
// inside the silhouette for 2 consecutive seconds the silhouette turns
// green and a Got it button appears. Skipping is allowed.
//
// On confirm: localStorage flips framing_calibrated=true. The caller
// (Mode B test page) reads this and skips the gate next time.

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import CameraPermissionBanner, {
  isInsecureContext,
  type CamState,
} from '@/components/CameraPermissionBanner';
import { SilhouetteGuide } from '@/components/FramingToast';
import { markFramingCalibrated } from '@/lib/pose/framingCalibration';
import { attachStream } from '@/lib/pose/cameraAttach';
import { PoseExtractor } from '@/lib/pose/poseExtractor';
import { SKELETON_EDGES } from '@/lib/pose/types';

// All landmark indices that draw in the skeleton overlay; we check that
// each of them is inside the silhouette before confirming.
const TRACKED_LANDMARKS = Array.from(
  new Set(SKELETON_EDGES.flatMap(([a, b]) => [a, b])),
);

const HOLD_MS = 2000;
// Silhouette occupies the middle ~80% of the frame horizontally and the
// top 90% vertically (matches SilhouetteGuide's viewBox layout).
const SILHOUETTE_X0 = 0.12;
const SILHOUETTE_X1 = 0.88;
const SILHOUETTE_Y0 = 0.05;
const SILHOUETTE_Y1 = 0.97;

export default function FrameCheckPage() {
  // Wrap in Suspense per Next 14 rules: useSearchParams() forces this page
  // out of static generation otherwise.
  return (
    <Suspense
      fallback={
        <main className="theme-dark flex h-full items-center justify-center bg-black text-white/60">
          loading…
        </main>
      }
    >
      <FrameCheckInner />
    </Suspense>
  );
}

function FrameCheckInner() {
  const router = useRouter();
  const search = useSearchParams();
  const returnTo = search.get('return') ?? '/';

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const extractorRef = useRef<PoseExtractor | null>(null);
  const rafRef = useRef<number | null>(null);
  const inFrameSinceRef = useRef<number | null>(null);

  const [camState, setCamState] = useState<CamState>('idle');
  const [allInside, setAllInside] = useState(false);

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
      const v = videoRef.current;
      if (!v) {
        setCamState('needs_tap');
        return;
      }
      const playing = await attachStream(v, stream);
      setCamState(playing ? 'granted' : 'needs_tap');
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      setCamState(name === 'NotAllowedError' ? 'denied' : 'unavailable');
    }
  }, []);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      extractorRef.current?.close();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Init pose extractor + detection loop when camera is ready.
  useEffect(() => {
    if (camState !== 'granted') return;
    let cancelled = false;
    const ex = new PoseExtractor();
    extractorRef.current = ex;
    ex.init().catch(() => {});
    const tick = () => {
      const v = videoRef.current;
      if (v && ex.ready && v.readyState >= 2) {
        const res = ex.detectFromVideo(v, performance.now());
        if (res) {
          let allIn = true;
          for (const i of TRACKED_LANDMARKS) {
            const lm = res.landmarks[i];
            if (!lm || (lm.visibility ?? 0) < 0.3) {
              allIn = false;
              break;
            }
            if (
              lm.x < SILHOUETTE_X0 ||
              lm.x > SILHOUETTE_X1 ||
              lm.y < SILHOUETTE_Y0 ||
              lm.y > SILHOUETTE_Y1
            ) {
              allIn = false;
              break;
            }
          }
          const now = performance.now();
          if (allIn) {
            if (inFrameSinceRef.current === null) inFrameSinceRef.current = now;
            if (now - inFrameSinceRef.current >= HOLD_MS) {
              setAllInside(true);
            }
          } else {
            inFrameSinceRef.current = null;
            setAllInside(false);
          }
        } else {
          inFrameSinceRef.current = null;
          setAllInside(false);
        }
      }
      if (!cancelled) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [camState]);

  function finish() {
    markFramingCalibrated();
    router.replace(returnTo);
  }

  return (
    <main className="theme-dark relative flex h-full w-full flex-col bg-black text-white">
      <header className="safe-top relative z-30 flex items-center justify-between px-4 pt-3 pb-2">
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
        <div className="text-xs font-medium uppercase tracking-[0.18em] text-white/70">
          framing check
        </div>
        <button
          type="button"
          onClick={() => router.replace(returnTo)}
          className="text-xs font-medium text-white/60 active:text-white"
        >
          skip
        </button>
      </header>

      <div className="relative flex-1 overflow-hidden bg-zinc-950">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className="absolute inset-0 h-full w-full object-cover [transform:scaleX(-1)]"
        />
        <SilhouetteGuide active={allInside} />
        {camState !== 'granted' && (
          <CameraPermissionBanner state={camState} onRequest={startCamera} />
        )}
        {camState === 'idle' && (
          // First render is `idle` — auto-request once.
          <RequestCameraOnMount onRequest={startCamera} />
        )}
      </div>

      <div className="safe-bottom flex flex-col gap-3 bg-black px-5 pt-4 pb-5">
        <p className="text-center text-sm text-white/80">
          stand back so your whole body fits the outline. plain wall behind
          you. find good light.
        </p>
        <button
          type="button"
          disabled={!allInside}
          onClick={finish}
          className={`rounded-full py-4 text-center text-base font-medium transition-colors ${
            allInside
              ? 'bg-white text-black active:scale-[0.98]'
              : 'bg-white/15 text-white/50'
          }`}
        >
          {allInside ? 'got it' : 'hold the pose…'}
        </button>
      </div>
    </main>
  );
}

function RequestCameraOnMount({ onRequest }: { onRequest: () => void }) {
  useEffect(() => {
    onRequest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
