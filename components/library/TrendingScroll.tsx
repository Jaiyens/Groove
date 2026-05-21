'use client';

import Link from 'next/link';
import { displayNameFor, type DanceListItem } from '@/lib/dances/types';
import PreviewablePoster from './PreviewablePoster';

interface TrendingScrollProps {
  dances: DanceListItem[];
}

export default function TrendingScroll({ dances }: TrendingScrollProps) {
  if (dances.length === 0) return null;
  return (
    <div className="-mx-5 overflow-x-auto no-scrollbar">
      <ul className="flex w-max gap-3 px-5 pb-1">
        {dances.map((dance) => (
          <li key={dance.id} className="w-[160px] shrink-0">
            <Link href={`/dance/${dance.id}`} className="block">
              <PreviewablePoster
                dance={dance}
                rounded="2xl"
                className="h-[200px] w-[160px] shadow-soft"
              />
              <div className="mt-2 px-1">
                <div className="line-clamp-2 text-sm font-semibold text-ink">
                  {displayNameFor(dance)}
                </div>
                {dance.creator_handle && (
                  <div className="text-xs text-ink-muted">
                    @{dance.creator_handle.replace(/^@/, '')}
                  </div>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
