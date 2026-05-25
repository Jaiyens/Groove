'use client';

import Link from 'next/link';
import { displayNameFor, type DanceListItem } from '@/lib/dances/types';
import DanceMetaRow from './DanceMetaRow';
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
      <ul className="flex w-max items-stretch gap-3 px-5 pb-1">
        {dances.map((dance) => (
          <li key={dance.id} className="flex w-[160px] shrink-0 flex-col">
            <PreviewablePoster
              dance={dance}
              rounded="2xl"
              className="h-[200px] w-[160px] shadow-soft"
              autoPlay
            />
            <Link href={`/dance/${dance.id}`} className="mt-2 flex flex-1 flex-col px-1">
              <div className="line-clamp-2 min-h-10 text-sm font-semibold leading-5 text-ink">
                {displayNameFor(dance)}
              </div>
              <DanceMetaRow dance={dance} className="mt-1" />
              <div className="min-h-4 text-xs text-ink-muted">
                {dance.creator_handle
                  ? `@${dance.creator_handle.replace(/^@/, '')}`
                  : null}
              </div>
              <div className="mt-auto pt-1 text-[11px] font-semibold uppercase tracking-wider text-ink">
                practice ›
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
