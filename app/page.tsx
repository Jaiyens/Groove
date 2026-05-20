'use client';

import BottomNav from '@/components/BottomNav';
import DanceCard from '@/components/DanceCard';
import { DANCES } from '@/lib/dances/fixtures';
import { useGraph } from '@/lib/graph/context';
import { computeReadiness } from '@/lib/graph/readiness';

const PLACEHOLDER_STREAK = 7;
const GREETING_NAME = 'Jaiyen';

export default function HomePage() {
  const { graph, error, mastery } = useGraph();

  return (
    <main className="flex h-full w-full flex-col bg-black">
      <div className="flex-1 overflow-y-auto no-scrollbar safe-top px-5 pt-5 pb-4">
        <header className="flex items-center justify-between mb-5">
          <div>
            <div className="text-text-muted text-xs">Welcome back</div>
            <div className="text-2xl font-bold">Hey, {GREETING_NAME}</div>
          </div>
          <div className="flex items-center gap-1.5 rounded-full bg-bg-card px-3 py-1.5 ring-1 ring-white/5">
            <span aria-hidden className="text-base">🔥</span>
            <span className="text-sm font-bold tabular-nums">{PLACEHOLDER_STREAK}</span>
          </div>
        </header>

        <button
          type="button"
          className="mb-6 flex w-full items-center gap-3 rounded-full bg-bg-card px-4 py-3 text-left text-text-muted ring-1 ring-white/5"
          aria-label="Search"
        >
          <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <span className="text-sm">paste a tiktok or search</span>
        </button>

        {error && (
          <div className="mb-4 rounded-xl border border-accent-red/40 bg-accent-red/10 p-3 text-sm text-accent-red">
            Failed to load knowledge graph: {error}
          </div>
        )}

        {!graph && !error && (
          <div className="space-y-3" aria-busy>
            <div className="h-48 w-full animate-pulse rounded-3xl bg-bg-card" />
            <div className="h-20 w-full animate-pulse rounded-2xl bg-bg-card" />
            <div className="h-20 w-full animate-pulse rounded-2xl bg-bg-card" />
          </div>
        )}

        {graph && (
          <>
            <DanceCard
              dance={DANCES[0]!}
              readinessPercent={computeReadiness({ dance: DANCES[0]!, graph, mastery }).percent}
              featured
            />

            <section className="mt-7">
              <div className="mb-3 flex items-end justify-between">
                <h2 className="text-lg font-bold">For You</h2>
                <span className="text-xs text-text-muted">{DANCES.length - 1} dances</span>
              </div>
              <div className="space-y-2">
                {DANCES.slice(1).map((dance) => {
                  const { percent } = computeReadiness({ dance, graph, mastery });
                  return (
                    <DanceCard key={dance.id} dance={dance} readinessPercent={percent} />
                  );
                })}
              </div>
            </section>
          </>
        )}
      </div>
      <BottomNav />
    </main>
  );
}
