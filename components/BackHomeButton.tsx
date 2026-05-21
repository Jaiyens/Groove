'use client';

// Universal back arrow. Calls router.back() so the user lands on the screen
// they came from. Falls back to `fallbackHref` (default "/") when the
// browser has no prior history entry inside the app (e.g. they opened a
// deep link). Use this on every non-home screen — the library is the
// home, every other screen has a back arrow.

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';

interface BackHomeButtonProps {
  className?: string;
  label?: string;
  fallbackHref?: string;
  // When true (default) shows the "Back" text alongside the chevron. Set
  // false for tight headers (e.g. the duet camera screen) where the chevron
  // alone is enough.
  showLabel?: boolean;
}

export default function BackHomeButton({
  className = '',
  label = 'Back',
  fallbackHref = '/',
  showLabel = true,
}: BackHomeButtonProps) {
  const router = useRouter();
  const onClick = useCallback(() => {
    // history.length is 1 when this is the first entry in the tab — there's
    // nothing to go back to, so route to the fallback. Otherwise router.back()
    // gives the natural "previous screen" behaviour the user expects.
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
    } else {
      router.push(fallbackHref);
    }
  }, [router, fallbackHref]);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`flex shrink-0 items-center gap-1.5 rounded-full bg-black/70 px-3 py-2 ring-1 ring-white/15 text-white backdrop-blur-sm active:scale-95 ${className}`}
    >
      <svg
        width={16}
        height={16}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M15 18l-6-6 6-6" />
      </svg>
      {showLabel && <span className="text-sm font-semibold">{label}</span>}
    </button>
  );
}
