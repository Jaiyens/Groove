'use client';

import { useCallback, useEffect, useState } from 'react';
import HeroCard from '@/components/library/HeroCard';
import TrendingScroll from '@/components/library/TrendingScroll';
import RecentList from '@/components/library/RecentList';
import SectionHeader from '@/components/library/SectionHeader';
import EmptyState from '@/components/library/EmptyState';
import CreamBottomNav from '@/components/library/CreamBottomNav';
import SubmitFab from '@/components/library/SubmitFab';
import type { DanceListItem } from '@/lib/dances/types';

// SubmitModal lands in Phase 4 — kept as a no-op for now.
const SubmitModalPlaceholder = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" className="absolute inset-0 z-50 flex items-center justify-center bg-cream/95">
      <div className="rounded-2xl bg-cream-card p-6 text-center shadow-lift">
        <p className="font-serif text-xl text-ink">submit flow coming up</p>
        <button onClick={onClose} className="mt-4 rounded-full bg-coral px-5 py-2 text-sm font-semibold text-white">
          close
        </button>
      </div>
    </div>
  );
};

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

  // Reload after the submit modal closes — a fresh dance may have just landed.
  useEffect(() => {
    if (!submitOpen) load();
  }, [submitOpen, load]);

  const { loading, error, dances, unconfigured } = state;
  const [featured, ...rest] = dances;
  const trending = rest.slice(0, 8);
  const recent = rest.slice(8, 24);

  return (
    <main className="theme-cream flex h-full w-full flex-col bg-cream">
      <div className="flex-1 overflow-y-auto no-scrollbar safe-top px-5 pt-6 pb-32">
        <header className="mb-7">
          <h1 className="font-serif text-[44px] leading-[1.05] tracking-tight text-ink">
            Groove
          </h1>
          <p className="mt-2 text-sm text-ink-muted">
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
          <div className="rounded-2xl border border-coral/40 bg-coral-soft/60 px-4 py-3 text-sm text-coral-deep">
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

            {trending.length > 0 && (
              <section className="mt-9">
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

      <SubmitModalPlaceholder open={submitOpen} onClose={() => setSubmitOpen(false)} />
    </main>
  );
}
