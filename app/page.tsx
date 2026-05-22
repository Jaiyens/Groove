'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import HeroCard from '@/components/library/HeroCard';
import TrendingScroll from '@/components/library/TrendingScroll';
import ContinueLearningRail from '@/components/library/ContinueLearningRail';
import RecentList from '@/components/library/RecentList';
import SectionHeader from '@/components/library/SectionHeader';
import EmptyState from '@/components/library/EmptyState';
import CreamBottomNav from '@/components/library/CreamBottomNav';
import SubmitFab from '@/components/library/SubmitFab';
import SubmitModal from '@/components/submit/SubmitModal';
import Logo from '@/components/Logo';
import type { DanceListItem } from '@/lib/dances/types';
import {
  CONTINUE_LEARNING_EVENT,
  getContinueLearningEntries,
  mergeContinueLearningEntry,
  type ContinueLearningEntry,
} from '@/lib/mastery/continueLearning';
import { getDanceProgress } from '@/lib/mastery/chunkProgress';

interface LibraryState {
  loading: boolean;
  error: string | null;
  dances: DanceListItem[];
  unconfigured: boolean;
}

export default function HomePage() {
  const [state, setState] = useState<LibraryState>({
    loading: true,
    error: null,
    dances: [],
    unconfigured: false,
  });
  const [submitOpen, setSubmitOpen] = useState(false);
  const [continueEntries, setContinueEntries] = useState<ContinueLearningEntry[]>([]);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await fetch('/api/dances', { cache: 'no-store' });
      const json = (await res.json()) as {
        dances: DanceListItem[];
        unconfigured?: boolean;
      };
      setState({
        loading: false,
        error: null,
        dances: json.dances ?? [],
        unconfigured: Boolean(json.unconfigured),
      });
    } catch (err) {
      setState({
        loading: false,
        error: err instanceof Error ? err.message : 'failed to load library',
        dances: [],
        unconfigured: false,
      });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const refreshContinueEntries = useCallback(() => {
    setContinueEntries(getContinueLearningEntries());
  }, []);

  useEffect(() => {
    refreshContinueEntries();
    window.addEventListener('focus', refreshContinueEntries);
    window.addEventListener('storage', refreshContinueEntries);
    window.addEventListener(CONTINUE_LEARNING_EVENT, refreshContinueEntries);
    return () => {
      window.removeEventListener('focus', refreshContinueEntries);
      window.removeEventListener('storage', refreshContinueEntries);
      window.removeEventListener(CONTINUE_LEARNING_EVENT, refreshContinueEntries);
    };
  }, [refreshContinueEntries]);

  // Reload after the submit modal closes — a fresh dance may have just landed.
  useEffect(() => {
    if (!submitOpen) load();
  }, [submitOpen, load]);

  const { loading, error, dances, unconfigured } = state;
  const [featured, ...rest] = dances;
  const trending = rest.slice(0, 8);
  const recent = rest.slice(8, 24);
  const continueLearning = useMemo(() => {
    const dancesById = new Map(dances.map((dance) => [dance.id, dance]));
    return continueEntries
      .map((entry) => mergeContinueLearningEntry(entry, dancesById.get(entry.danceId)))
      .filter((entry) => getDanceProgress(entry.danceId).highestPassed < entry.totalChunks - 1)
      .slice(0, 8);
  }, [continueEntries, dances]);

  return (
    <main className="theme-cream relative flex h-full w-full flex-col bg-cream">
      <div className="flex-1 overflow-y-auto no-scrollbar safe-top px-5 pt-6 pb-[calc(56px+64px+16px+env(safe-area-inset-bottom))]">
        <header className="mb-7">
          <h1 className="leading-[1.05]">
            <Logo className="text-[52px]">groovy</Logo>
          </h1>
          <p className="mt-3 text-sm text-ink-muted">
            learn any tiktok dance, one chunk at a time
          </p>
        </header>

        {loading && (
          <div className="space-y-4" aria-busy>
            <div className="h-[280px] w-full animate-pulse rounded-[28px] bg-cream-deep" />
            <div className="h-[200px] w-full animate-pulse rounded-2xl bg-cream-deep" />
          </div>
        )}

        {!loading && error && (
          <div className="rounded-2xl border border-accent-red/30 bg-accent-red/10 px-4 py-3 text-sm text-accent-red">
            {error}
          </div>
        )}

        {!loading && !error && dances.length === 0 && (
          <EmptyState
            onSubmit={() => setSubmitOpen(true)}
            unconfigured={unconfigured}
          />
        )}

        {!loading && !error && featured && (
          <>
            <HeroCard dance={featured} />

            {continueLearning.length > 0 && (
              <section className="mt-6">
                <SectionHeader
                  title="continue where you left off"
                  subtitle="pick up your practice"
                />
                <ContinueLearningRail entries={continueLearning} />
              </section>
            )}

            {trending.length > 0 && (
              <section className="mt-6">
                <SectionHeader title="trending" subtitle="what other dancers are picking up" />
                <TrendingScroll dances={trending} />
              </section>
            )}

            {recent.length > 0 && (
              <section className="mt-9">
                <SectionHeader title="new to the library" />
                <RecentList dances={recent} />
              </section>
            )}
          </>
        )}
      </div>

      {!loading && dances.length > 0 && (
        <SubmitFab onClick={() => setSubmitOpen(true)} />
      )}

      <CreamBottomNav />

      <SubmitModal open={submitOpen} onClose={() => setSubmitOpen(false)} />
    </main>
  );
}
