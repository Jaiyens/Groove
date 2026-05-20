'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import BackHomeButton from '@/components/BackHomeButton';
import ChunkProgression, {
  type ChunkProgressionItem,
  type ChunkState,
} from '@/components/ChunkProgression';
import { getDance } from '@/lib/dances/fixtures';
import { useGraph } from '@/lib/graph/context';
import { chunkRoutine, type Chunk } from '@/lib/graph/chunker';
import { isRoutineNode } from '@/lib/graph/types';
import {
  getDanceProgress,
  isFullUnlocked,
} from '@/lib/mastery/chunkProgress';

interface PageProps {
  params: { danceId: string };
}

export default function DanceOverviewPage({ params }: PageProps) {
  const router = useRouter();
  const { graph } = useGraph();

  const dance = useMemo(
    () => (graph ? getDance(params.danceId, graph) : undefined),
    [graph, params.danceId],
  );

  const chunks: Chunk[] = useMemo(() => {
    if (!graph || !dance) return [];
    const routineNode = graph.nodes.find((n) => n.id === dance.id);
    if (!routineNode || !isRoutineNode(routineNode)) return [];
    return chunkRoutine(routineNode, {
      nameOf: (id) => graph.nodes.find((n) => n.id === id)?.name,
    });
  }, [graph, dance]);

  // Re-read progress on mount + when window regains focus, so completing a
  // chunk in another tab/route updates the lock state here on return.
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

  const items: ChunkProgressionItem[] = useMemo(() => {
    if (!dance || chunks.length === 0) return [];
    const progress = getDanceProgress(dance.id);
    return chunks.map((c) => {
      let state: ChunkState;
      if (progress.highestPassed >= c.index) state = 'passed';
      else if (c.index === 0 || progress.highestPassed >= c.index - 1)
        state = 'unlocked';
      else state = 'locked';
      return {
        chunk: c,
        state,
        lastScore: progress.lastScores[c.index],
      };
    });
    // progressTick read so the effect-driven re-read invalidates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dance, chunks, progressTick]);

  useEffect(() => {
    if (graph && !dance) router.replace('/');
  }, [graph, dance, router]);

  if (!graph || !dance) {
    return (
      <main className="flex h-full items-center justify-center text-text-muted">
        Loading…
      </main>
    );
  }

  const totalChunks = chunks.length;
  const passedCount = items.filter((i) => i.state === 'passed').length;
  const fullUnlocked = dance ? isFullUnlocked(dance.id, totalChunks) : false;

  return (
    <main className="flex h-full w-full flex-col bg-black">
      <header className="safe-top flex items-center gap-3 px-4 pt-3 pb-2">
        <BackHomeButton />
        <div className="flex-1 text-center">
          <div className="text-[10px] uppercase tracking-widest text-text-muted">
            Lesson
          </div>
          <div className="text-sm font-bold">{dance.name}</div>
        </div>
        <div className="w-[68px]" aria-hidden />
      </header>

      <div className="flex-1 overflow-y-auto no-scrollbar px-4 pt-2 pb-6">
        <section className="mb-5 rounded-2xl bg-gradient-to-br from-accent/20 to-accent-cyan/15 p-4 ring-1 ring-white/10">
          <div className="text-[10px] uppercase tracking-widest text-text-muted">
            Now learning
          </div>
          <h1 className="text-2xl font-bold leading-tight">{dance.name}</h1>
          <div className="text-sm text-text-muted">
            {dance.artist} · {dance.bpm} BPM · {dance.duration_seconds}s
          </div>
          <div className="mt-3 flex items-center justify-between text-xs">
            <span className="text-text-muted">
              {passedCount} of {totalChunks} chunks
            </span>
            <span className="font-bold tabular-nums text-accent-green">
              {totalChunks > 0
                ? Math.round((passedCount / totalChunks) * 100)
                : 0}
              %
            </span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full bg-accent-green transition-[width] duration-300"
              style={{
                width: `${totalChunks > 0 ? (passedCount / totalChunks) * 100 : 0}%`,
              }}
            />
          </div>
        </section>

        {totalChunks > 0 ? (
          <ChunkProgression
            danceId={dance.id}
            items={items}
            fullUnlocked={fullUnlocked}
          />
        ) : (
          <div className="rounded-xl border border-accent-amber/40 bg-accent-amber/10 p-3 text-sm text-accent-amber">
            This dance has no chunkable routine data.
          </div>
        )}

        <div className="mt-6 text-center">
          <Link
            href="/"
            className="text-xs uppercase tracking-widest text-text-muted"
          >
            back to library
          </Link>
        </div>
      </div>
    </main>
  );
}
