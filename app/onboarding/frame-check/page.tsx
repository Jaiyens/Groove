'use client';

// Hands-free framing gate (spec.md round-5).
//
// Shows the camera full-screen with a knees-up silhouette overlay.
// Detects pose every frame and feeds `isUpperBodyFramed` into a
// FramingGate. Once the user is framed for 1.5 s, the gate counts down
// 5 → 4 → 3 → 2 → 1 → GO at 800 ms intervals with audible ticks; if
// framing breaks for ≥0.5 s mid-count, the gate resets and the
// silhouette guide is shown again. On GO we flip framing_calibrated
// in localStorage and route to the original target — no tap required.
// A small bottom-left "skip" link is the only escape hatch.

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import CameraPermissionBanner, {
  isInsecureContext,
  type CamState,
} from '@/components/CameraPermissionBanner';
import { UpperBodySilhouetteGuide } from '@/components/FramingToast';
import { playTick } from '@/lib/audio/tick';
import { attachStream } from '@/lib/pose/cameraAttach';
import {
  COUNT_START,
  FramingGate,
  type FramingPhase,
  isUpperBodyFramed,
} from '@/lib/pose/framingCheck';
import {
  markFramingCalibrated,
  markFramingGateJustFired,
} from '@/lib/pose/framingCalibration';
import { PoseExtractor } from '@/lib/pose/poseExtractor';

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
  const gateRef = useRef<FramingGate>(new FramingGate());
  const firedRef = useRef(false);
  const returnToRef = useRef(returnTo);
  useEffect(() => {
    returnToRef.current = returnTo;
  }, [returnTo]);

  const [camState, setCamState] = useState<CamState>('idle');
  const [phase, setPhase] = useState<FramingPhase>('searching');
  const [count, setCount] = useState<number>(COUNT_START);

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

  // Init pose extractor + per-frame loop when camera is granted.
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
        const framed = res ? isUpperBodyFramed(res.landmarks) : false;
        const result = gateRef.current.tick(framed, performance.now());
        setPhase((prev) => (prev === result.phase ? prev : result.phase));
        setCount((prev) => (prev === result.count ? prev : result.count));
        if (result.tickFired !== undefined) {
          playTick({ emphasis: result.tickFired === 'go' });
        }
        if (result.fired && !firedRef.current) {
          firedRef.current = true;
          markFramingCalibrated();
          // spec.md round-5 §Fix 2: hand off to Mode A so it knows to
          // skip its own start-screen + countdown (the user is across
          // the room and just heard 5-4-3-2-1-GO).
          markFramingGateJustFired();
          // Defer the route swap by ~600 ms so the "GO" flash is
          // actually visible.
          window.setTimeout(() => router.replace(returnToRef.current), 600);
        }
      }
      if (!cancelled) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [camState, router]);

  const skip = useCallback(() => {
    markFramingCalibrated();
    router.replace(returnToRef.current);
  }, [router]);

  const isFramed = phase === 'arming' || phase === 'counting' || phase === 'fired';
  const showCountdown = phase === 'counting' || phase === 'fired';

  return (
    <main className="theme-dark relative flex h-full w-full flex-col bg-black text-white">
      <header className="safe-top relative z-30 flex flex-col items-center gap-1 px-4 pt-4 pb-3">
        <h1 className="text-lg font-semibold text-white">step back so we can see you</h1>
        <p className="text-center text-xs text-white/70">
          knees up is enough — dance starts automatically when you&rsquo;re framed
        </p>
      </header>

      <div className="relative flex-1 overflow-hidden bg-zinc-950">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className="absolute inset-0 h-full w-full object-cover [transform:scaleX(-1)]"
        />
        {!showCountdown && <UpperBodySilhouetteGuide active={isFramed} />}
        {camState !== 'granted' && (
          <CameraPermissionBanner state={camState} onRequest={startCamera} />
        )}
        {camState === 'idle' && (
          <RequestCameraOnMount onRequest={startCamera} />
        )}

        {/* 5-4-3-2-1 → GO. Hot pink, centred, big enough to read from
            across the room. Visible while phase === 'counting' or
            'fired' (fired briefly shows GO before navigation). */}
        {showCountdown && (
          <div
            className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center"
            aria-live="polite"
            aria-atomic="true"
          >
            <div
              className="text-[28vh] font-medium leading-none tabular-nums text-coral drop-shadow-[0_4px_24px_rgba(0,0,0,0.6)]"
              data-testid="framing-countdown"
            >
              {phase === 'fired' ? 'GO' : count}
            </div>
          </div>
        )}
      </div>

      {/* spec.md round-5 §3: tiny low-contrast skip link, bottom-left.
          The skip itself flips framing_calibrated so the user isn't
          bounced back here on the next chunk tap. */}
      <div className="safe-bottom relative bg-black px-5 pt-3 pb-5">
        <button
          type="button"
          onClick={skip}
          className="text-xs font-medium text-white/40 active:text-white/80"
        >
          skip
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
