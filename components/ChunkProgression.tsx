'use client';

import Link from 'next/link';
import type { Chunk } from '@/lib/graph/chunker';

export type ChunkState = 'locked' | 'unlocked' | 'passed';

export interface ChunkProgressionItem {
  chunk: Chunk;
  state: ChunkState;
  lastScore?: number; // 0..100 if ever attempted
}

interface ChunkProgressionProps {
  danceId: string;
  items: ChunkProgressionItem[];
  // True if Mode C (full attempt) is unlocked.
  fullUnlocked: boolean;
}

export default function ChunkProgression({
  danceId,
  items,
  fullUnlocked,
}: ChunkProgressionProps) {
  return (
    <div className="space-y-4">
      <ol className="relative space-y-3 pl-1">
        {items.map((item, i) => (
          <li key={item.chunk.index} className="relative">
            {i < items.length - 1 && (
              <span
                aria-hidden
                className="absolute left-6 top-12 -bottom-3 w-px bg-white/10"
              />
            )}
            <ChunkRow danceId={danceId} item={item} stepNumber={i + 1} />
          </li>
        ))}
      </ol>

      <Link
        href={fullUnlocked ? `/dance/${danceId}/full` : '#'}
        aria-disabled={!fullUnlocked}
        onClick={(e) => {
          if (!fullUnlocked) e.preventDefault();
        }}
        className={`mt-2 flex items-center justify-between rounded-2xl p-4 ring-1 transition-colors ${
          fullUnlocked
            ? 'bg-gradient-to-br from-accent/30 to-accent-cyan/20 ring-white/15 active:scale-[0.99]'
            : 'bg-bg-card/60 ring-white/5 opacity-60 cursor-not-allowed'
        }`}
      >
        <div>
          <div className="text-[10px] uppercase tracking-widest text-text-muted">
            Final
          </div>
          <div className="text-lg font-bold leading-tight">
            Full attempt
          </div>
          <div className="text-xs text-text-muted mt-0.5">
            {fullUnlocked
              ? 'audio only · full DTW scoring'
              : 'unlocks when every chunk is passed'}
          </div>
        </div>
        <div
          className={`flex h-12 w-12 items-center justify-center rounded-full ring-2 ${
            fullUnlocked ? 'bg-white text-black ring-white' : 'bg-bg-card text-white/40 ring-white/15'
          }`}
        >
          {fullUnlocked ? <PlayIcon /> : <LockIcon />}
        </div>
      </Link>
    </div>
  );
}

function ChunkRow({
  danceId,
  item,
  stepNumber,
}: {
  danceId: string;
  item: ChunkProgressionItem;
  stepNumber: number;
}) {
  const { chunk, state, lastScore } = item;
  const locked = state === 'locked';
  const passed = state === 'passed';

  const tint = locked
    ? 'bg-bg-card/60 ring-white/5'
    : passed
      ? 'bg-accent-green/15 ring-accent-green/40'
      : 'bg-bg-card ring-white/10';
  const dot = locked
    ? 'bg-bg-elevated text-white/40 ring-white/10'
    : passed
      ? 'bg-accent-green text-black ring-accent-green'
      : 'bg-white text-black ring-white';

  const inner = (
    <div className={`flex items-center gap-3 rounded-2xl p-3 ring-1 ${tint}`}>
      <div
        className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full font-bold ring-2 ${dot}`}
      >
        {locked ? <LockIcon /> : passed ? <CheckIcon /> : stepNumber}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-widest text-text-muted">
          Chunk {stepNumber}
        </div>
        <div className="truncate text-sm font-semibold">{chunk.label}</div>
        <div className="text-[11px] text-text-muted">
          {Math.round((chunk.endMs - chunk.startMs) / 100) / 10}s
          {lastScore !== undefined && ` · last ${lastScore}`}
        </div>
      </div>
      {!locked && (
        <div className="text-[11px] font-bold uppercase tracking-widest text-text-muted">
          {passed ? 'replay' : 'start'}
        </div>
      )}
    </div>
  );

  if (locked) return inner;
  return (
    <Link
      href={`/dance/${danceId}/chunk/${chunk.index}/copy`}
      className="block active:scale-[0.99] transition-transform"
    >
      {inner}
    </Link>
  );
}

function CheckIcon() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m5 12 5 5L20 7" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M7 10V7a5 5 0 0 1 10 0v3h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h1Zm2 0h6V7a3 3 0 0 0-6 0v3Z" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}
