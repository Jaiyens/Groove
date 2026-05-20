'use client';

import Link from 'next/link';
import type { DanceListItem } from '@/lib/dances/types';
import DanceThumb from './DanceThumb';

interface HeroCardProps {
  dance: DanceListItem;
}

export default function HeroCard({ dance }: HeroCardProps) {
  return (
    <Link
      href={`/dance/${dance.id}`}
      className="block overflow-hidden rounded-[28px] bg-cream-card shadow-soft transition-transform active:scale-[0.99]"
    >
      <DanceThumb
        dance={dance}
        rounded="lg"
        className="aspect-[4/3] w-full rounded-none"
      />
      <div className="px-5 pt-4 pb-5">
        <div className="text-xs font-medium uppercase tracking-[0.18em] text-coral">
          featured
        </div>
        <h3 className="mt-1 font-serif text-[28px] leading-tight text-ink">
          {dance.title ?? 'Untitled'}
        </h3>
        {dance.creator_handle && (
          <p className="mt-1 text-sm text-ink-muted">
            @{dance.creator_handle.replace(/^@/, '')}
          </p>
        )}
        <div className="mt-4 inline-flex items-center gap-2 rounded-full bg-coral px-5 py-2.5 text-sm font-semibold text-white">
          <span>tap to learn</span>
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M5 12h14M13 5l7 7-7 7" />
          </svg>
        </div>
      </div>
    </Link>
  );
}
