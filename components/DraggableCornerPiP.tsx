'use client';

// FaceTime-style draggable picture-in-picture. Grab anywhere on the card,
// drag freely, release → snaps to the nearest corner with a quick ease.
// Position persists in localStorage when a `storageKey` is provided.
//
// Behavior:
//   - Pointer events (works for mouse, touch, pen)
//   - Tap vs drag disambiguated by a 5px movement threshold — sub-threshold
//     pointerups don't change corners, so children that have their own
//     click handlers (e.g. CameraPermissionBanner buttons) still work.
//   - touch-action: none on the container prevents touch scroll from
//     hijacking the drag.

import { useCallback, useEffect, useRef, useState } from 'react';

export type PiPCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

interface Props {
  children: React.ReactNode;
  defaultCorner?: PiPCorner;
  // localStorage key for persisting the corner across sessions. Omit
  // for per-session-only positioning.
  storageKey?: string;
  // Tailwind classes for the OUTER positioning wrapper. Use this to
  // control sizing (width, max-width). Inset is managed by the component.
  className?: string;
}

const CORNER_CLASS: Record<PiPCorner, string> = {
  'top-left': 'top-3 left-3',
  'top-right': 'top-3 right-3',
  'bottom-left': 'bottom-3 left-3',
  'bottom-right': 'bottom-3 right-3',
};

const DRAG_THRESHOLD_PX = 5;

export default function DraggableCornerPiP({
  children,
  defaultCorner = 'bottom-left',
  storageKey,
  className = '',
}: Props) {
  const [corner, setCorner] = useState<PiPCorner>(defaultCorner);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const didDragRef = useRef(false);

  // Load persisted corner on mount (avoids SSR mismatch by reading after
  // mount rather than in the initializer).
  useEffect(() => {
    if (!storageKey || typeof localStorage === 'undefined') return;
    const stored = localStorage.getItem(storageKey);
    if (
      stored === 'top-left' ||
      stored === 'top-right' ||
      stored === 'bottom-left' ||
      stored === 'bottom-right'
    ) {
      setCorner(stored);
    }
  }, [storageKey]);

  const setAndPersistCorner = useCallback(
    (next: PiPCorner) => {
      setCorner(next);
      if (storageKey && typeof localStorage !== 'undefined') {
        try { localStorage.setItem(storageKey, next); } catch { /* ignore */ }
      }
    },
    [storageKey],
  );

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    pointerStartRef.current = { x: e.clientX, y: e.clientY };
    didDragRef.current = false;
    // Don't setPointerCapture here — if we capture on every press, an iOS
    // Safari pointerup-drop leaves a stuck capture that blocks clicks on
    // other elements (e.g. the header back button). Capture lazily, only
    // once the user has actually crossed the drag threshold.
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const start = pointerStartRef.current;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!didDragRef.current && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
      didDragRef.current = true;
      try {
        wrapperRef.current?.setPointerCapture(e.pointerId);
      } catch { /* already captured or invalid pointer */ }
    }
    if (didDragRef.current) setDragOffset({ x: dx, y: dy });
  }, []);

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const start = pointerStartRef.current;
      pointerStartRef.current = null;
      try {
        wrapperRef.current?.releasePointerCapture(e.pointerId);
      } catch { /* already released */ }
      if (!didDragRef.current || !start || !wrapperRef.current) {
        setDragOffset(null);
        return;
      }
      // Snap to the corner of the viewport quadrant the PiP's center
      // currently lives in.
      const rect = wrapperRef.current.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const horizontal = centerX < window.innerWidth / 2 ? 'left' : 'right';
      const vertical = centerY < window.innerHeight / 2 ? 'top' : 'bottom';
      setAndPersistCorner(`${vertical}-${horizontal}` as PiPCorner);
      setDragOffset(null);
      didDragRef.current = false;
    },
    [setAndPersistCorner],
  );

  const isDragging = dragOffset !== null;
  const transform = dragOffset
    ? `translate(${dragOffset.x}px, ${dragOffset.y}px)`
    : undefined;

  return (
    <div
      ref={wrapperRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      className={`absolute z-20 ${CORNER_CLASS[corner]} ${className} ${
        isDragging
          ? 'cursor-grabbing'
          : 'cursor-grab transition-all duration-300 ease-out'
      }`}
      style={{ transform, touchAction: 'none' }}
    >
      {children}
    </div>
  );
}
