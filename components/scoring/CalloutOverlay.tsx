'use client';

// Live-callout visual layer — Just-Dance-quality redesign
// (SPECK §generosity-rewrite §CalloutOverlay).
//
// What changed vs the previous version:
//   - Position moved bottom-of-frame (~80% viewport) so the stamp doesn't
//     cover the user's face. Previously dead-centered.
//   - Per-tier visual treatment: each tier looks distinct (color, stroke,
//     glow, motion) — not just text color. GROOVY adds a particle burst
//     on entry; ALMOST stays quiet (no stroke, no glow, just a slate fade).
//   - Heavier display face: Bungee (loaded via next/font in app/layout.tsx)
//     with tight letter-spacing and slight italic skew.
//   - Per-tier animation timing: GROOVY has overshoot + apex shake, PERFECT
//     and GREAT have progressively gentler scale-ins, ALMOST is opacity-only.
//
// A new event (new object identity) immediately replaces the active stamp.
// No queueing. Pointer-events: none, z-20 (above skeleton z-10, below
// results z-40). No sound — sound design deferred to a later spec.

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

// Total on-screen duration per tier. Used to schedule the unmount timer
// so React can throw away the SVG / particle nodes once the animation is
// done — keeps GC pressure low during a 30s attempt.
const TIER_DURATION_MS: Record<CalloutTier, number> = {
  GROOVY: 1000, // 200ms in + 500ms hold + 300ms out
  PERFECT: 880, // 180ms in + 450ms hold + 250ms out
  GREAT: 800, // 150ms in + 400ms hold + 250ms out
  ALMOST: 800, // 0 → 0.7 → 0 over 800ms
};

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
    hideTimerRef.current = setTimeout(
      () => setActive(null),
      TIER_DURATION_MS[event.tier],
    );
  }, [event]);

  useEffect(
    () => () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    },
    [],
  );

  if (!active) return null;

  const tierClass = `callout-tier-${active.tier.toLowerCase()}`;

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-20"
    >
      {/* Position the stamp at ~80% down the viewport, centered horizontally.
          Using top-[80%] + -translate-y-1/2 keeps the text optical-center on
          that line regardless of the rendered glyph height. */}
      <div className="absolute left-1/2 top-[80%] -translate-x-1/2 -translate-y-1/2">
        <div key={active.key} className={`callout-root ${tierClass}`}>
          <span className="callout-text">{active.tier}</span>
          {active.tier === 'GROOVY' && <ParticleBurst />}
        </div>
      </div>
      <style jsx>{`
        .callout-root {
          position: relative;
          display: inline-block;
        }
        .callout-text {
          display: inline-block;
          font-family: var(--font-bungee), 'Bungee', 'Arial Black', system-ui,
            sans-serif;
          font-size: 64px;
          line-height: 0.9;
          letter-spacing: -0.02em;
          text-transform: uppercase;
          transform: skewX(-3deg);
          user-select: none;
          white-space: nowrap;
          will-change: transform, opacity;
        }

        /* GROOVY — brand pink, white outer stroke, pink radial glow, particles.
           Animation: overshoot scale 0.6 → 1.15 → 1.0 in 200ms (snappy spring),
           hold 500ms, fade out 300ms. A 2-frame rotational shake hits at apex. */
        .callout-tier-groovy .callout-text {
          color: #ff1f8e;
          -webkit-text-stroke: 4px #ffffff;
          paint-order: stroke fill;
          filter: drop-shadow(0 0 18px rgba(255, 31, 142, 0.65))
            drop-shadow(0 0 36px rgba(255, 31, 142, 0.35));
          animation: callout-groovy 1000ms forwards;
        }
        @keyframes callout-groovy {
          0% {
            opacity: 0;
            transform: skewX(-3deg) scale(0.6) rotate(0deg);
          }
          15% {
            /* 150 / 1000 — overshoot */
            opacity: 1;
            transform: skewX(-3deg) scale(1.15) rotate(-2deg);
          }
          18% {
            transform: skewX(-3deg) scale(1.12) rotate(2deg);
          }
          20% {
            /* 200 / 1000 — settle */
            opacity: 1;
            transform: skewX(-3deg) scale(1) rotate(0deg);
          }
          70% {
            /* 200 + 500 — hold end */
            opacity: 1;
            transform: skewX(-3deg) scale(1) rotate(0deg);
          }
          100% {
            opacity: 0;
            transform: skewX(-3deg) scale(1) rotate(0deg);
          }
        }

        /* PERFECT — white fill, pink stroke (3px), no glow, no particles.
           Scale 0.7 → 1.1 → 1.0, 180ms in, hold 450ms, fade 250ms. */
        .callout-tier-perfect .callout-text {
          color: #ffffff;
          -webkit-text-stroke: 3px #ff1f8e;
          paint-order: stroke fill;
          animation: callout-perfect 880ms forwards;
        }
        @keyframes callout-perfect {
          0% {
            opacity: 0;
            transform: skewX(-3deg) scale(0.7);
          }
          15% {
            opacity: 1;
            transform: skewX(-3deg) scale(1.1);
          }
          20.5% {
            /* 180 / 880 */
            opacity: 1;
            transform: skewX(-3deg) scale(1);
          }
          71.6% {
            /* (180 + 450) / 880 */
            opacity: 1;
            transform: skewX(-3deg) scale(1);
          }
          100% {
            opacity: 0;
            transform: skewX(-3deg) scale(1);
          }
        }

        /* GREAT — white fill, thin white stroke (1px), no glow. Minimal.
           Scale 0.8 → 1.0, 150ms in, hold 400ms, fade 250ms. */
        .callout-tier-great .callout-text {
          color: #ffffff;
          -webkit-text-stroke: 1px #ffffff;
          paint-order: stroke fill;
          animation: callout-great 800ms forwards;
        }
        @keyframes callout-great {
          0% {
            opacity: 0;
            transform: skewX(-3deg) scale(0.8);
          }
          18.75% {
            /* 150 / 800 */
            opacity: 1;
            transform: skewX(-3deg) scale(1);
          }
          68.75% {
            /* (150 + 400) / 800 */
            opacity: 1;
            transform: skewX(-3deg) scale(1);
          }
          100% {
            opacity: 0;
            transform: skewX(-3deg) scale(1);
          }
        }

        /* ALMOST — muted slate, no stroke, no glow, no scale.
           Opacity-only 0 → 0.7 → 0 over 800ms. Quietly visible. */
        .callout-tier-almost .callout-text {
          color: #94a3b8;
          -webkit-text-stroke: 0;
          animation: callout-almost 800ms forwards;
        }
        @keyframes callout-almost {
          0% {
            opacity: 0;
          }
          25% {
            opacity: 0.7;
          }
          75% {
            opacity: 0.7;
          }
          100% {
            opacity: 0;
          }
        }
      `}</style>
    </div>
  );
}

// 5 small dots radiating outward from the stamp center on GROOVY entry.
// Pink/white mix; ~200ms fade-in, ~400ms fade-out. Implemented as inline
// SVG with per-circle CSS transitions so the whole thing GC's with the
// stamp's unmount.
function ParticleBurst() {
  // Hand-picked angles + radii so the spread looks deliberate rather than
  // procedurally even. Two pink, three white.
  const particles: Array<{ x: number; y: number; r: number; c: string; delay: number }> = [
    { x: -1.0, y: -0.6, r: 4, c: '#FF1F8E', delay: 0 },
    { x: 1.1, y: -0.4, r: 3, c: '#FFFFFF', delay: 30 },
    { x: -0.6, y: 0.9, r: 3, c: '#FFFFFF', delay: 50 },
    { x: 0.8, y: 0.8, r: 4, c: '#FF1F8E', delay: 20 },
    { x: 1.4, y: 0.1, r: 2.5, c: '#FFFFFF', delay: 60 },
  ];
  const VIEW = 220;
  const CENTER = VIEW / 2;
  const SPREAD_PX = 70;

  return (
    <svg
      width={VIEW}
      height={VIEW}
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      className="callout-particles"
      style={{
        position: 'absolute',
        left: '50%',
        top: '50%',
        transform: 'translate(-50%, -50%)',
        pointerEvents: 'none',
      }}
    >
      {particles.map((p, i) => (
        <circle
          key={i}
          cx={CENTER + p.x * SPREAD_PX}
          cy={CENTER + p.y * SPREAD_PX}
          r={p.r}
          fill={p.c}
          style={{
            transformOrigin: `${CENTER}px ${CENTER}px`,
            animation: `callout-particle 600ms ${p.delay}ms ease-out forwards`,
            opacity: 0,
          }}
        />
      ))}
      <style>{`
        @keyframes callout-particle {
          0% {
            opacity: 0;
            transform: scale(0.2);
          }
          33% {
            /* 200ms / 600ms — fade in done */
            opacity: 1;
            transform: scale(1);
          }
          100% {
            /* 400ms more — fade out */
            opacity: 0;
            transform: scale(1.4);
          }
        }
      `}</style>
    </svg>
  );
}
