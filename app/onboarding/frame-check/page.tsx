'use client';

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
import { markFramingCalibrated } from '@/lib/pose/framingCalibration';
import { PoseExtractor } from '@/lib/pose/poseExtractor';

export default function FrameCheckPage() {
  return (
    <Suspense
      fallback={
        <main className="theme-dark flex h-full items-center justify-center bg-black text-white/60">
          loading...
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
      <button
        type="button"
        onClick={skip}
        className="absolute right-4 top-[calc(env(safe-area-inset-top,0px)+14px)] z-50 rounded-full bg-[#FF3E7F] px-5 py-3 text-sm font-bold text-white shadow-[0_10px_30px_rgba(255,62,127,0.28)] ring-1 ring-white/25 active:scale-95"
      >
        skip
      </button>

      <header className="safe-top relative z-30 flex flex-col items-center gap-1 px-24 pt-4 pb-3">
        <h1 className="text-center text-lg font-semibold text-white">
          step back so we can see you
        </h1>
        <p className="text-center text-xs text-white/70">
          knees up is enough - dance starts automatically when you're framed
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
        {camState === 'idle' && <RequestCameraOnMount onRequest={startCamera} />}

        {showCountdown && (
          <div
            className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center"
            aria-live="polite"
            aria-atomic="true"
          >
            <div
              className="text-[28vh] font-medium leading-none tabular-nums text-[#FF3E7F] drop-shadow-[0_4px_24px_rgba(0,0,0,0.6)]"
              data-testid="framing-countdown"
            >
              {phase === 'fired' ? 'GO' : count}
            </div>
          </div>
        )}
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
