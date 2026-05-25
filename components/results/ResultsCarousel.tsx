'use client';

// Horizontal card carousel for the results-as-learning flow. Five
// focused screens (score → nailed → miss → drill → next) instead of
// one long scroll. Each card is a child slot the parent fills.
//
// Navigation:
//   - Tap "continue" button on a card → advance one
//   - Swipe horizontally → advance / go back
//   - Tap a progress dot → jump to that card
//   - Header back arrow → go back one (or exit if on first)
//
// The carousel handles state + transforms + swipe gestures only. Each
// card is responsible for its own internal layout, animation, and
// CTA. The "next" button per card is a render prop so the last card
// can render multiple CTAs instead of a single advance.

import { useCallback, useEffect, useRef, useState } from 'react';

export interface CarouselCard {
  // Stable key for React.
  key: string;
  // Visible content of this card.
  content: React.ReactNode;
  // Bottom action area. If omitted, the carousel renders a default
  // "continue" button (or "done" on the last card). The final card
  // typically passes its own multi-CTA stack.
  actions?: React.ReactNode;
}

interface Props {
  cards: CarouselCard[];
  // Called when the user pulls the back arrow on the first card.
  onExit?: () => void;
}

const SWIPE_THRESHOLD_PX = 60;

export default function ResultsCarousel({ cards, onExit }: Props) {
  const [index, setIndex] = useState(0);
  const [dragOffset, setDragOffset] = useState(0);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const pointerStartRef = useRef<{ x: number; y: number; id: number } | null>(null);
  const containerWidthRef = useRef<number>(0);

  const total = cards.length;
  const clamped = Math.max(0, Math.min(index, total - 1));

  const goTo = useCallback(
    (next: number) => {
      const bounded = Math.max(0, Math.min(next, total - 1));
      setIndex(bounded);
      setDragOffset(0);
    },
    [total],
  );

  const goNext = useCallback(() => goTo(clamped + 1), [clamped, goTo]);
  const goPrev = useCallback(() => goTo(clamped - 1), [clamped, goTo]);
  const exit = useCallback(() => {
    if (onExit) onExit();
  }, [onExit]);

  // Touch / mouse swipe handlers. Tracks horizontal delta only; if
  // the vertical delta dominates we ignore the gesture so vertical
  // scrolls inside a card aren't hijacked.
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pointerStartRef.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
      containerWidthRef.current = trackRef.current?.parentElement?.clientWidth ?? 0;
    },
    [],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const start = pointerStartRef.current;
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      // Vertical scroll wins — release the swipe.
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 12) {
        pointerStartRef.current = null;
        setDragOffset(0);
        return;
      }
      // Capture so the move events keep flowing even if the pointer
      // leaves the original element.
      if (Math.abs(dx) > 5) {
        try {
          trackRef.current?.setPointerCapture(e.pointerId);
        } catch {
          /* already captured */
        }
        setDragOffset(dx);
      }
    },
    [],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const start = pointerStartRef.current;
      pointerStartRef.current = null;
      try {
        trackRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      const dx = start ? e.clientX - start.x : dragOffset;
      if (Math.abs(dx) >= SWIPE_THRESHOLD_PX) {
        if (dx < 0) goNext();
        else goPrev();
      } else {
        setDragOffset(0);
      }
    },
    [dragOffset, goNext, goPrev],
  );

  // Cancel any in-flight drag on unmount so a stuck pointer capture
  // doesn't leak across navigations.
  useEffect(
    () => () => {
      pointerStartRef.current = null;
    },
    [],
  );

  const containerWidth = containerWidthRef.current || 0;
  // Track has the same width as the parent; each slide inside is
  // w-full + flex-shrink-0 so siblings overflow to the right. A
  // translateX of -100% moves the track exactly one slide-width
  // because the track's own width equals one slide.
  const baseOffsetPercent = -clamped * 100;
  const dragPercent =
    containerWidth > 0 ? (dragOffset / containerWidth) * 100 : 0;
  // Disable transition while dragging so the track follows the finger;
  // re-enable on release for the snap.
  const transitionClass = pointerStartRef.current ? '' : 'transition-transform duration-300 ease-out';

  return (
    <div className="flex h-full w-full flex-col bg-cream text-ink">
      <header className="safe-top relative z-10 flex h-12 items-center justify-between px-4 pt-2">
        <button
          type="button"
          onClick={clamped === 0 ? exit : goPrev}
          aria-label={clamped === 0 ? 'exit results' : 'previous card'}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-cream-card text-ink shadow-soft active:scale-95"
        >
          <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div
          role="tablist"
          aria-label="Results step"
          className="flex items-center gap-1.5"
        >
          {cards.map((card, i) => {
            const active = i === clamped;
            return (
              <button
                key={card.key}
                type="button"
                role="tab"
                aria-selected={active}
                aria-label={`go to step ${i + 1} of ${total}`}
                onClick={() => goTo(i)}
                className={`h-1.5 rounded-full transition-all duration-200 ${
                  active ? 'w-6 bg-ink' : 'w-1.5 bg-ink/25 hover:bg-ink/45'
                }`}
              />
            );
          })}
        </div>
        <div className="w-10" aria-hidden />
      </header>

      {/* Swipe-able card track. Each child is a full-width slide; the
          flex track translates horizontally by -100% per slide. The
          parent has overflow-hidden so only the active slide shows. */}
      <div
        className="relative flex-1 overflow-hidden"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{ touchAction: 'pan-y' }}
      >
        <div
          ref={trackRef}
          className={`flex h-full w-full ${transitionClass}`}
          style={{
            transform: `translateX(calc(${baseOffsetPercent}% + ${dragPercent}%))`,
          }}
        >
          {cards.map((card) => (
            <div
              key={card.key}
              className="flex h-full w-full flex-shrink-0 flex-col"
            >
              <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-3 pt-2">
                {card.content}
              </div>
              <div className="safe-bottom px-5 pb-5 pt-2">
                {card.actions ?? (
                  <button
                    type="button"
                    onClick={goNext}
                    className="w-full rounded-full bg-ink py-4 text-sm font-bold uppercase tracking-[0.18em] text-cream-card active:scale-[0.99]"
                  >
                    continue
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function CarouselNextButton({
  label = 'continue',
  onClick,
}: {
  label?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-full bg-ink py-4 text-sm font-bold uppercase tracking-[0.18em] text-cream-card active:scale-[0.99]"
    >
      {label}
    </button>
  );
}
