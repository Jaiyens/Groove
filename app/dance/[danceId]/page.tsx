'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useDance } from '@/lib/dances/useDance';
import { bumpView } from '@/lib/dances/api';
import ChunkPath, {
  type ChunkPathItem,
  type ChunkState,
} from '@/components/lesson/ChunkPath';
import ProcessingState from '@/components/lesson/ProcessingState';
import DanceThumb from '@/components/library/DanceThumb';
import {
  getDanceProgress,
  isFullUnlocked,
} from '@/lib/mastery/chunkProgress';

interface PageProps {
  params: { danceId: string };
}

export default function DanceOverviewPage({ params }: PageProps) {
  const router = useRouter();
  const { loading, notFound, dance, chunks, record } = useDance(params.danceId);

  useEffect(() => {
    if (record?.status === 'ready') bumpView(record.id);
  }, [record]);

  // Re-read progress on mount + when window regains focus
  const [progressTick, setProgressTick] = useState(0);
  useEffect(() => {
    const bump = () => setProgressTick((t) => t + 1);
    window.addEventListener('focus', bump);
    window.addEventListener('storage', bump);
    return () => {
      window.removeEventListener('focus', bump);
      window.removeEventListener('storage', bump);
    };
  }, []);

  const items: ChunkPathItem[] = useMemo(() => {
    if (!dance || chunks.length === 0) return [];
    const progress = getDanceProgress(dance.id);
    return chunks.map((c) => {
      let state: ChunkState;
      if (progress.highestPassed >= c.index) state = 'passed';
      else if (c.index === 0 || progress.highestPassed >= c.index - 1)
        state = 'unlocked';
      else state = 'locked';
      return { chunk: c, state, lastScore: progress.lastScores[c.index] };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dance, chunks, progressTick]);

  useEffect(() => {
    if (notFound) router.replace('/');
  }, [notFound, router]);

  if (loading) {
    return (
      <main className="theme-cream flex h-full w-full items-center justify-center bg-cream text-ink-muted">
        Loading…
      </main>
    );
  }

  if (!record) {
    return (
      <main className="theme-cream flex h-full w-full items-center justify-center bg-cream text-ink-muted">
        not found
      </main>
    );
  }

  if (record.status !== 'ready' || !dance) {
    return <ProcessingState initial={record} />;
  }

  const totalChunks = chunks.length;
  const passedCount = items.filter((i) => i.state === 'passed').length;
  const fullUnlocked = isFullUnlocked(dance.id, totalChunks);
  const progressPercent = totalChunks > 0
    ? Math.round((passedCount / totalChunks) * 100)
    : 0;

  return (
    <main className="theme-cream flex h-full w-full flex-col bg-cream">
      <header className="safe-top flex items-center gap-3 px-5 pt-5 pb-3">
        <button
          type="button"
          onClick={() => {
            if (typeof window !== 'undefined' && window.history.length > 1) {
              router.back();
            } else {
              router.push('/');
            }
          }}
          aria-label="Back"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-cream-card text-ink shadow-soft active:scale-95"
        >
          <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className="flex-1 text-center text-xs font-medium uppercase tracking-[0.18em] text-ink">
          lesson
        </div>
        <div className="w-10" aria-hidden />
      </header>

      <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-8">
        <section className="overflow-hidden rounded-[28px] bg-cream-card shadow-soft">
          <DanceThumb
            dance={{ title: dance.name, thumbnail_url: dance.thumbnail_url }}
            rounded="lg"
            className="aspect-[16/10] w-full rounded-none"
          />
          <div className="px-5 pt-4 pb-5">
            <h1 className="text-2xl font-medium leading-tight tracking-tight text-ink">
              {dance.name}
            </h1>
            {dance.artist && (
              <p className="mt-1 text-sm text-ink-muted">
                @{dance.artist.replace(/^@/, '')}
              </p>
            )}
            <div className="mt-3 flex items-center gap-3 text-xs text-ink-muted">
              <span>{dance.bpm.toFixed(0)} BPM</span>
              <span aria-hidden>·</span>
              <span>{dance.duration_seconds.toFixed(1)}s</span>
              {dance.low_quality && (
                <>
                  <span aria-hidden>·</span>
                  <span className="text-accent-amber">low quality reference</span>
                </>
              )}
            </div>
            <div className="mt-4">
              <div className="flex items-center justify-between text-xs">
                <span className="text-ink-muted">
                  {passedCount} of {totalChunks} chunks
                </span>
                <span className="font-medium tabular-nums text-ink">
                  {progressPercent}%
                </span>
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-cream-deep">
                <div
                  className="h-full bg-ink transition-[width] duration-300"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          </div>
        </section>

        <section className="mt-7">
          <h2 className="mb-3 text-lg font-medium tracking-tight text-ink">your path</h2>
          {totalChunks > 0 ? (
            <ChunkPath
              danceId={dance.id}
              items={items}
              fullUnlocked={fullUnlocked}
            />
          ) : (
            <div className="rounded-2xl bg-cream-card p-4 text-sm text-ink-muted shadow-soft">
              This dance hasn’t been chunked yet. Try resubmitting it.
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
