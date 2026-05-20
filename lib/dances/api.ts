// API-driven dance fetching. Replaces the hardcoded fixture lookup.
// All public dance reads + writes flow through this module.

import type { DanceRecord, DanceListItem } from './types';

export async function fetchLibrary(): Promise<DanceListItem[]> {
  const res = await fetch('/api/dances', { cache: 'no-store' });
  if (!res.ok) throw new Error(`library fetch failed: ${res.status}`);
  const data = (await res.json()) as { dances: DanceListItem[] };
  return data.dances;
}

export async function fetchDance(id: string): Promise<DanceRecord | null> {
  const res = await fetch(`/api/dances/${id}`, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`dance fetch failed: ${res.status}`);
  return (await res.json()) as DanceRecord;
}

export async function submitDance(tiktokUrl: string): Promise<{ id: string }> {
  const res = await fetch('/api/dances/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tiktok_url: tiktokUrl }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `submit failed: ${res.status}`);
  }
  return (await res.json()) as { id: string };
}

export async function bumpView(id: string): Promise<void> {
  await fetch(`/api/dances/${id}/view`, { method: 'POST' }).catch(() => {});
}

// Poll a dance until status changes. Returns the final record (ready or failed)
// or throws if the polling itself errors. `onTick` is called with each
// intermediate record so the UI can rotate loading messages.
export async function pollUntilReady(
  id: string,
  opts: {
    intervalMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    onTick?: (record: DanceRecord) => void;
  } = {},
): Promise<DanceRecord> {
  const interval = opts.intervalMs ?? 2000;
  const timeout = opts.timeoutMs ?? 5 * 60_000;
  const start = Date.now();
  for (;;) {
    if (opts.signal?.aborted) throw new Error('aborted');
    const record = await fetchDance(id);
    if (!record) throw new Error('dance not found');
    opts.onTick?.(record);
    if (record.status === 'ready' || record.status === 'failed') return record;
    if (Date.now() - start > timeout) throw new Error('polling timed out');
    await sleep(interval);
  }
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
