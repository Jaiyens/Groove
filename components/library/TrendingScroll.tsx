'use client';

import Link from 'next/link';
import { displayNameFor, type DanceListItem } from '@/lib/dances/types';
import PreviewablePoster from './PreviewablePoster';

interface TrendingScrollProps {
  dances: DanceListItem[];
}

// SPECK §Fix 1: thumbnail is its own preview surface; the title +
// "practice" link sits beneath it as the navigation affordance.
export default function TrendingScroll({ dances }: TrendingScrollProps) {
  if (dances.length === 0) return null;
  return (
    <div className="-mx-5 overflow-x-auto no-scrollbar">
      <ul className="flex w-max gap-3 px-5 pb-1">
        {dances.map((dance) => (
          <li key={dance.id} className="w-[160px] shrink-0">
            <PreviewablePoster
              dance={dance}
              rounded="2xl"
              className="h-[200px] w-[160px] shadow-soft"
            />
            <Link href={`/dance/${dance.id}`} className="mt-2 block px-1">
              <div className="line-clamp-2 text-sm font-semibold text-ink">
                {displayNameFor(dance)}
              </div>
              {dance.creator_handle && (
                <div className="text-xs text-ink-muted">
                  @{dance.creator_handle.replace(/^@/, '')}
                </div>
              )}
              <div className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-coral">
                practice ›
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
