'use client';

// React context for the loaded KnowledgeGraph + a tick-counter for mastery.
// Single fetch per app load; the validator throws clearly if the graph is bad.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { loadGraph } from './loader';
import type { KnowledgeGraph } from './types';
import { getMasteryStore } from '@/lib/mastery/store';

interface GraphContextValue {
  graph: KnowledgeGraph | null;
  error: string | null;
  // bumped whenever mastery is mutated, so consumers can re-read
  masteryTick: number;
  bumpMastery: () => void;
  mastery: Record<string, number>;
}

const GraphContext = createContext<GraphContextValue | null>(null);

export function GraphProvider({ children }: { children: ReactNode }) {
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [masteryTick, setMasteryTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    loadGraph()
      .then((g) => {
        if (!cancelled) setGraph(g);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (!cancelled) setError(message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const mastery = useMemo(() => {
    if (typeof window === 'undefined') return {};
    return getMasteryStore().getAllMastery();
    // re-run when bump fires
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [masteryTick]);

  const value = useMemo<GraphContextValue>(
    () => ({
      graph,
      error,
      masteryTick,
      mastery,
      bumpMastery: () => setMasteryTick((t) => t + 1),
    }),
    [graph, error, masteryTick, mastery],
  );

  return <GraphContext.Provider value={value}>{children}</GraphContext.Provider>;
}

export function useGraph(): GraphContextValue {
  const ctx = useContext(GraphContext);
  if (!ctx) {
    throw new Error('useGraph must be called inside a <GraphProvider>');
  }
  return ctx;
}
