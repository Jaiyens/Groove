'use client';

// Live-callout visual layer. Subscribes (via prop) to the latest
// CalloutEvent and flashes the tier text large + centered over the camera.
// Vibe only — no sound. Spec animation:
//   scale 0.7 → 1.0 with 150ms ease-out, hold 400ms, fade-out 250ms.
//   Total on-screen ~800ms.
// Z-index lives above the skeleton overlay (z-10) but below results layer
// (z-40). A new callout while one is still animating immediately replaces
// it — no queueing.

import { useEffect, useRef, useState } from 'react';

import type { CalloutEvent, CalloutTier } from '@/lib/scoring/callouts/types';

interface CalloutOverlayProps {
  // Latest event from the engine. Passing the same event reference twice
  // is a no-op; pass a fresh CalloutEvent (new object identity) to retrigger.
  event: CalloutEvent | null;
}

interface ActiveCallout {
  // Monotonic key so React remounts the animated node on each new event,
  // restarting the CSS animation cleanly even when tier is the same.
  key: number;
  tier: CalloutTier;
}

const TIER_TEXT_CLASSES: Record<CalloutTier, string> = {
  GROOVY: 'text-[#FF1F8E] drop-shadow-[0_0_24px_rgba(255,31,142,0.55)]',
  PERFECT: 'text-white [-webkit-text-stroke:2px_#FF1F8E]',
  GREAT: 'text-white',
  ALMOST: 'text-[#BBBBBB]',
};

const TOTAL_MS = 800;

export default function CalloutOverlay({ event }: CalloutOverlayProps) {
  const [active, setActive] = useState<ActiveCallout | null>(null);
  const counterRef = useRef(0);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastEventRef = useRef<CalloutEvent | null>(null);

  useEffect(() => {
    if (!event || event === lastEventRef.current) return;
    lastEventRef.current = event;
    counterRef.current += 1;
    setActive({ key: counterRef.current, tier: event.tier });
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setActive(null), TOTAL_MS);
  }, [event]);

  useEffect(
    () => () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    },
    [],
  );

  if (!active) return null;

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center"
    >
      <span
        key={active.key}
        className={`callout-anim select-none text-[64px] font-black uppercase leading-none tracking-tight tabular-nums ${TIER_TEXT_CLASSES[active.tier]}`}
        style={{ fontFamily: 'system-ui, -apple-system, "Helvetica Neue", sans-serif' }}
      >
        {active.tier}
      </span>
      <style jsx>{`
        @keyframes calloutFlash {
          0% {
            opacity: 0;
            transform: scale(0.7);
          }
          18.75% {
            /* 150ms / 800ms = 18.75% — scale-in done */
            opacity: 1;
            transform: scale(1);
          }
          68.75% {
            /* 150ms + 400ms = 550ms / 800ms = 68.75% — hold ends */
            opacity: 1;
            transform: scale(1);
          }
          100% {
            opacity: 0;
            transform: scale(1);
          }
        }
        .callout-anim {
          animation: calloutFlash ${TOTAL_MS}ms ease-out forwards;
          will-change: transform, opacity;
        }
      `}</style>
    </div>
  );
}
