'use client';

import Link from 'next/link';
import DanceThumb from '@/components/library/DanceThumb';
import { displayNameFor } from '@/lib/dances/types';
import type { ContinueLearningEntry } from '@/lib/mastery/continueLearning';

interface ContinueLearningRailProps {
  entries: ContinueLearningEntry[];
}

export default function ContinueLearningRail({ entries }: ContinueLearningRailProps) {
  if (entries.length === 0) return null;

  return (
    <div className="-mx-5 overflow-x-auto no-scrollbar">
      <ul className="flex w-max items-stretch gap-3 px-5 pb-1">
        {entries.map((entry) => {
          const chunkNumber = entry.currentChunkIndex + 1;
          const progressPercent = Math.round(
            (chunkNumber / entry.totalChunks) * 100,
          );
          return (
            <li key={entry.danceId} className="w-[160px] shrink-0">
              <Link
                href={`/dance/${entry.danceId}/chunk/${entry.currentChunkIndex}/copy`}
                className="block rounded-2xl bg-cream-card pb-3 shadow-soft active:scale-[0.99]"
              >
                <DanceThumb
                  dance={{
                    title: entry.title,
                    display_name: entry.displayName,
                    thumbnail_url: entry.thumbnailUrl,
                  }}
                  rounded="2xl"
                  className="h-[200px] w-[160px]"
                />
                <div className="px-2 pt-2">
                  <div className="line-clamp-2 min-h-10 text-sm font-semibold leading-5 text-ink">
                    {displayNameFor({
                      title: entry.title,
                      display_name: entry.displayName,
                    })}
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-cream-deep">
                    <div
                      className="h-full rounded-full bg-coral transition-[width] duration-300"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                  <div className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-ink">
                    chunk {chunkNumber}/{entry.totalChunks}
                  </div>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
