'use client';

import Link from 'next/link';
import type { Dance } from '@/lib/dances/types';

interface DanceCardProps {
  dance: Dance;
  readinessPercent: number; // 0..100 int
  featured?: boolean;
}

function readyTier(percent: number) {
  if (percent >= 80) return { ring: 'ring-accent-green', text: 'text-accent-green' };
  if (percent >= 60) return { ring: 'ring-accent-amber', text: 'text-accent-amber' };
  if (percent > 0) return { ring: 'ring-accent-red', text: 'text-accent-red' };
  return { ring: 'ring-text-dim', text: 'text-text-muted' };
}

export default function DanceCard({ dance, readinessPercent, featured }: DanceCardProps) {
  const tier = readyTier(readinessPercent);

  if (featured) {
    return (
      <Link
        href={`/practice/${dance.id}`}
        className="relative block overflow-hidden rounded-3xl bg-gradient-to-br from-accent to-accent-cyan/70 p-5 active:scale-[0.98] transition-transform"
      >
        <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent" />
        <div className="relative flex items-end justify-between min-h-[160px]">
          <div className="flex-1">
            <div className="text-xs uppercase tracking-widest text-white/80 mb-1">
              Trending now
            </div>
            <div className="text-3xl font-bold leading-tight">{dance.name}</div>
            <div className="text-sm text-white/80 mt-1">
              {dance.artist} · {dance.bpm} BPM
            </div>
          </div>
          <div
            className={`shrink-0 rounded-full bg-black/40 backdrop-blur ring-2 ${tier.ring} px-3 py-1.5 text-sm font-bold ${tier.text} tabular-nums`}
          >
            {readinessPercent}% ready
          </div>
        </div>
      </Link>
    );
  }

  return (
    <Link
      href={`/practice/${dance.id}`}
      className="flex items-center gap-4 rounded-2xl bg-bg-card p-3.5 active:bg-bg-elevated transition-colors"
    >
      <div className="h-14 w-14 shrink-0 rounded-xl bg-gradient-to-br from-accent/80 to-accent-cyan/60 flex items-center justify-center text-lg font-bold">
        {dance.name[0]}
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-semibold truncate">{dance.name}</div>
        <div className="text-xs text-text-muted truncate">
          {dance.artist} · {dance.duration_seconds}s
        </div>
      </div>
      <div
        className={`shrink-0 text-sm font-bold tabular-nums ${tier.text}`}
        aria-label={`${readinessPercent} percent ready`}
      >
        {readinessPercent}%
      </div>
    </Link>
  );
}
