'use client';

import Link from 'next/link';
import { displayNameFor, type DanceListItem } from '@/lib/dances/types';
import PreviewablePoster from './PreviewablePoster';

interface RecentListProps {
  dances: DanceListItem[];
}

// SPECK §Fix 1: thumbnail tap plays the preview with sound; the text
// area + chevron is its own <Link> for navigation. The row itself is
// not a single link anymore — keeps the preview and navigation
// affordances cleanly separated.
export default function RecentList({ dances }: RecentListProps) {
  if (dances.length === 0) return null;
  return (
    <ul className="space-y-3">
      {dances.map((dance) => (
        <li
          key={dance.id}
          className="flex items-center gap-4 rounded-2xl bg-cream-card p-3 shadow-soft"
        >
          <PreviewablePoster
            dance={dance}
            rounded="xl"
            className="h-16 w-16 shrink-0"
          />
          <Link
            href={`/dance/${dance.id}`}
            className="flex min-w-0 flex-1 items-center gap-2 active:opacity-70"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-base font-medium text-ink leading-tight">
                {displayNameFor(dance)}
              </div>
              {dance.creator_handle && (
                <div className="truncate text-xs text-ink-muted">
                  @{dance.creator_handle.replace(/^@/, '')}
                </div>
              )}
              <div className="mt-0.5 text-[11px] font-semibold uppercase tracking-wider text-ink">
                practice
              </div>
            </div>
            <div className="shrink-0 text-ink-dim">
              <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M9 6l6 6-6 6" />
              </svg>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
