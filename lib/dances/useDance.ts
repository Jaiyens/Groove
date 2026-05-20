'use client';

// React hook for loading a DanceRecord from the API and adapting it to the
// legacy `Dance` shape the practice routes consume.

import { useEffect, useMemo, useState } from 'react';
import { fetchDance } from './api';
import { recordToDance } from './adapter';
import type { Dance, DanceRecord, ChunkBoundary } from './types';

export interface UseDanceResult {
  loading: boolean;
  notFound: boolean;
  error: string | null;
  dance: Dance | undefined;
  chunks: ChunkBoundary[];
  record: DanceRecord | null;
}

export function useDance(id: string): UseDanceResult {
  const [record, setRecord] = useState<DanceRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    setError(null);
    fetchDance(id)
      .then((r) => {
        if (cancelled) return;
        if (!r) setNotFound(true);
        else setRecord(r);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'failed to load dance');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const dance = useMemo(
    () => (record ? recordToDance(record) ?? undefined : undefined),
    [record],
  );
  const chunks = useMemo(
    () => buildChunkList(record),
    [record],
  );

  return { loading, notFound, error, dance, chunks, record };
}

function buildChunkList(record: DanceRecord | null): ChunkBoundary[] {
  if (!record || !record.chunks_json) return [];
  return record.chunks_json.map((c, i) => ({
    index: typeof c.index === 'number' ? c.index : i,
    startMs: c.startMs,
    endMs: c.endMs,
    skills: Array.isArray(c.skills) ? c.skills : [],
    label: c.label ?? `section ${i + 1}`,
  }));
}
