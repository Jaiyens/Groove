'use client';

import Link from 'next/link';
import type { DanceListItem } from '@/lib/dances/types';
import DanceThumb from './DanceThumb';

interface RecentListProps {
  dances: DanceListItem[];
}

export default function RecentList({ dances }: RecentListProps) {
  if (dances.length === 0) return null;
  return (
    <ul className="space-y-3">
      {dances.map((dance) => (
        <li key={dance.id}>
          <Link
            href={`/dance/${dance.id}`}
            className="flex items-center gap-4 rounded-2xl bg-cream-card p-3 shadow-soft active:bg-cream-deep"
          >
            <DanceThumb
              dance={dance}
              rounded="xl"
              className="h-16 w-16 shrink-0"
            />
            <div className="min-w-0 flex-1">
              <div className="truncate font-serif text-lg text-ink leading-tight">
                {dance.title ?? 'Untitled'}
              </div>
              {dance.creator_handle && (
                <div className="truncate text-xs text-ink-muted">
                  @{dance.creator_handle.replace(/^@/, '')}
                </div>
              )}
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
