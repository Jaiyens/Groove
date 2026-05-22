'use client';

import Link from 'next/link';
import { displayNameFor, type DanceListItem } from '@/lib/dances/types';
import PreviewablePoster from './PreviewablePoster';

interface HeroCardProps {
  dance: DanceListItem;
}

// SPECK §Fix 1: the card is no longer a single <Link>. The poster
// is its own tappable surface (plays the preview with sound), and
// the "practice" CTA at the bottom navigates into the dance.
export default function HeroCard({ dance }: HeroCardProps) {
  return (
    <div className="overflow-hidden rounded-[28px] bg-cream-card shadow-soft">
      <PreviewablePoster
        dance={dance}
        rounded="lg"
        className="aspect-[4/3] w-full rounded-none"
      />
      <div className="px-5 pt-4 pb-5">
        <div className="text-xs font-medium uppercase tracking-[0.18em] text-ink-muted">
          featured
        </div>
        <h3 className="mt-1 text-[26px] font-medium leading-tight text-ink">
          {displayNameFor(dance)}
        </h3>
        {dance.creator_handle && (
          <p className="mt-1 text-sm text-ink-muted">
            @{dance.creator_handle.replace(/^@/, '')}
          </p>
        )}
        <Link
          href={`/dance/${dance.id}`}
          className="mt-4 inline-flex items-center gap-2 rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-cream-card active:scale-[0.98]"
        >
          <span>practice</span>
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M5 12h14M13 5l7 7-7 7" />
          </svg>
        </Link>
      </div>
    </div>
  );
}
