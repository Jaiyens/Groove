'use client';

// Simply Piano-style lesson tree. Rounded nodes connected by curves,
// locked / unlocked / passed states.

import Link from 'next/link';
import type { ChunkBoundary } from '@/lib/dances/types';

export type ChunkState = 'locked' | 'unlocked' | 'passed';

export interface ChunkPathItem {
  chunk: ChunkBoundary;
  state: ChunkState;
  lastScore?: number;
}

interface ChunkPathProps {
  danceId: string;
  items: ChunkPathItem[];
  fullUnlocked: boolean;
}

export default function ChunkPath({ danceId, items, fullUnlocked }: ChunkPathProps) {
  return (
    <div className="relative">
      <ol className="space-y-3">
        {items.map((item, i) => (
          <li key={item.chunk.index} className="relative">
            {i < items.length - 1 && (
              <span
                aria-hidden
                className="absolute left-[34px] top-[68px] -bottom-3 w-[3px] rounded-full bg-ink/8"
              />
            )}
            <ChunkRow danceId={danceId} item={item} stepNumber={i + 1} />
          </li>
        ))}
      </ol>

      <Link
        href={`/dance/${danceId}/full`}
        className={`mt-5 flex items-center justify-between rounded-3xl p-5 transition-transform ${
          fullUnlocked
            ? 'bg-cream-card text-ink shadow-soft active:scale-[0.99]'
            : 'bg-cream-deep text-ink-dim pointer-events-none'
        }`}
      >
        <div>
          <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-ink-muted">
            practice
          </div>
          <div className="text-xl font-medium leading-tight">
            full dance copy-along
          </div>
          <div className="mt-0.5 text-xs text-ink-muted">
            rehearse the whole routine with the reference
          </div>
        </div>
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-ink text-cream-card">
          <PlayIcon />
        </div>
      </Link>

      <Link
        href={`/dance/${danceId}/test`}
        className={`mt-3 flex items-center justify-between rounded-3xl p-5 transition-transform ${
          fullUnlocked
            ? 'bg-ink text-cream-card shadow-lift active:scale-[0.99]'
            : 'bg-cream-deep text-ink-dim pointer-events-none'
        }`}
      >
        <div>
          <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-cream-card/80">
            final
          </div>
          <div className="text-xl font-medium leading-tight">
            take the test
          </div>
          <div className="mt-0.5 text-xs text-cream-card/80">
            you dance alone · scored by AI
          </div>
        </div>
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-cream-card text-ink">
          <PlayIcon />
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
  item: ChunkPathItem;
  stepNumber: number;
}) {
  const { chunk, state, lastScore } = item;
  const locked = state === 'locked';
  const passed = state === 'passed';

  const card = passed
    ? 'bg-cream-card ring-cream-deep'
    : locked
      ? 'bg-cream-deep ring-ink/5 opacity-70'
      : 'bg-cream-card ring-cream-deep shadow-soft';
  const dot = passed
    ? 'bg-ink text-cream-card shadow-soft'
    : locked
      ? 'bg-cream-card text-ink-dim ring-1 ring-cream-deep'
      : 'bg-ink text-cream-card shadow-soft';

  const inner = (
    <div className={`flex items-center gap-4 rounded-2xl p-4 ring-1 ${card}`}>
      <div
        className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full font-serif text-lg ${dot}`}
      >
        {locked ? <LockIcon /> : passed ? <CheckIcon /> : stepNumber}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-ink-muted">
          chunk {stepNumber}
        </div>
        <div className="truncate text-lg font-medium leading-tight text-ink">
          {chunk.label}
        </div>
        <div className="mt-0.5 text-[11px] text-ink-muted">
          {Math.round((chunk.endMs - chunk.startMs) / 100) / 10}s
          {lastScore !== undefined && (
            <>
              {' · '}
              <span className={lastScore >= 70 ? 'text-accent-green' : 'text-ink-muted'}>
                last {lastScore}
              </span>
            </>
          )}
        </div>
      </div>
      {!locked && (
        <div className="text-[11px] font-medium uppercase tracking-widest text-ink">
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
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m5 12 5 5L20 7" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M7 10V7a5 5 0 0 1 10 0v3h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h1Zm2 0h6V7a3 3 0 0 0-6 0v3Z" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}
