'use client';

// SPECK overnight Track 2 §debug-scoring eval harness. Pick a set of
// saved attempts, hit "Re-score all," watch a progress bar, get a
// table of per-attempt old-score / new-score / delta / tier change.
//
// Dev-only. The point is to be able to run "what did this prompt
// change do?" across a saved suite of attempts in a single click.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  base64ToBlob,
  listAttempts,
  type SavedAttempt,
} from '@/lib/debug/attemptStore';
import { scoreWithGemini } from '@/lib/scoring/gemini/client';

type RowState =
  | { kind: 'pending' }
  | { kind: 'running' }
  | { kind: 'done'; oldScore: number | null; newScore: number | null; oldTier: string | null; newTier: string | null; latencyMs: number }
  | { kind: 'error'; reason: string };

export default function EvalPage() {
  const [attempts, setAttempts] = useState<SavedAttempt[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [running, setRunning] = useState<boolean>(false);
  const [completed, setCompleted] = useState<number>(0);
  const [total, setTotal] = useState<number>(0);

  useEffect(() => {
    void (async () => {
      const list = await listAttempts();
      setAttempts(list);
      setSelected(Object.fromEntries(list.map((a) => [a.id, true])));
    })();
  }, []);

  const toggleAll = useCallback(
    (on: boolean) => {
      setSelected(Object.fromEntries(attempts.map((a) => [a.id, on])));
    },
    [attempts],
  );

  const selectedIds = useMemo(
    () => attempts.filter((a) => selected[a.id]).map((a) => a.id),
    [attempts, selected],
  );

  const handleRunAll = useCallback(async () => {
    if (running || selectedIds.length === 0) return;
    setRunning(true);
    setCompleted(0);
    setTotal(selectedIds.length);
    const init: Record<string, RowState> = {};
    for (const id of selectedIds) init[id] = { kind: 'pending' };
    setRows(init);

    // Serial: Gemini's per-call cost + the page's hidden-video setup
    // means parallelism here would hurt (each call spawns its own
    // <video> + canvas + recorder graph).
    for (const id of selectedIds) {
      const attempt = attempts.find((a) => a.id === id);
      if (!attempt) continue;
      setRows((prev) => ({ ...prev, [id]: { kind: 'running' } }));
      try {
        const blob = base64ToBlob(attempt.attemptBlobBase64, attempt.attemptMimeType);
        const result = await scoreWithGemini({
          attemptBlob: blob,
          referenceVideoUrl: attempt.referenceUrl,
          chunkStartMs: attempt.chunkStartMs,
          chunkEndMs: attempt.chunkEndMs,
          legsVisible: attempt.legsVisible,
          danceId: attempt.danceId,
          chunkIndex: attempt.chunkIndex,
        });
        if (result.kind === 'success') {
          setRows((prev) => ({
            ...prev,
            [id]: {
              kind: 'done',
              oldScore: readScalarNumber(attempt.responseRaw, 'overall_score'),
              newScore: typeof result.score.overall_score === 'number' ? result.score.overall_score : null,
              oldTier: readScalarString(attempt.responseRaw, 'tier'),
              newTier: typeof result.score.tier === 'string' ? result.score.tier : null,
              latencyMs: result.latencyMs,
            },
          }));
        } else {
          setRows((prev) => ({ ...prev, [id]: { kind: 'error', reason: result.reason } }));
        }
      } catch (err) {
        setRows((prev) => ({
          ...prev,
          [id]: { kind: 'error', reason: err instanceof Error ? err.message : 'unknown' },
        }));
      } finally {
        setCompleted((c) => c + 1);
      }
    }
    setRunning(false);
  }, [attempts, selectedIds, running]);

  return (
    <main className="theme-cream flex h-full w-full flex-col bg-cream">
      <div className="border-b border-cream-deep px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/debug/scoring" className="text-xs text-ink-muted hover:text-ink">
            ← Debug
          </Link>
          <h1 className="text-base font-bold">Eval Harness</h1>
          <button
            type="button"
            onClick={() => toggleAll(true)}
            className="rounded-full bg-cream-card px-3 py-1 text-xs font-bold text-ink ring-1 ring-cream-deep"
          >
            Select all
          </button>
          <button
            type="button"
            onClick={() => toggleAll(false)}
            className="rounded-full bg-cream-card px-3 py-1 text-xs font-bold text-ink ring-1 ring-cream-deep"
          >
            Select none
          </button>
          <button
            type="button"
            onClick={handleRunAll}
            disabled={running || selectedIds.length === 0}
            className="rounded-full bg-coral px-3 py-1 text-xs font-bold text-white disabled:opacity-50"
          >
            {running ? `Running ${completed}/${total}…` : `Re-score ${selectedIds.length}`}
          </button>
          {total > 0 && (
            <progress
              value={completed}
              max={total}
              className="ml-2 h-2 w-40 align-middle"
            />
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {attempts.length === 0 ? (
          <div className="text-sm text-ink-muted">
            No saved attempts. Capture some first on{' '}
            <Link href="/debug/scoring" className="underline">/debug/scoring</Link>.
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-left text-[10px] uppercase tracking-wider text-ink-muted">
              <tr>
                <th className="py-1 pr-2"></th>
                <th className="py-1 pr-2">Dance</th>
                <th className="py-1 pr-2">Chunk</th>
                <th className="py-1 pr-2">Saved</th>
                <th className="py-1 pr-2">Old</th>
                <th className="py-1 pr-2">New</th>
                <th className="py-1 pr-2">Δ</th>
                <th className="py-1 pr-2">Tier</th>
                <th className="py-1 pr-2">Latency</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((a) => {
                const row = rows[a.id];
                return (
                  <tr key={a.id} className="border-t border-cream-deep">
                    <td className="py-1 pr-2">
                      <input
                        type="checkbox"
                        checked={!!selected[a.id]}
                        onChange={(e) =>
                          setSelected((prev) => ({ ...prev, [a.id]: e.target.checked }))
                        }
                        disabled={running}
                        aria-label={`Select ${a.id}`}
                      />
                    </td>
                    <td className="py-1 pr-2">{a.danceId}</td>
                    <td className="py-1 pr-2 tabular-nums">{a.chunkIndex}</td>
                    <td className="py-1 pr-2 tabular-nums text-ink-muted">
                      {new Date(a.savedAt).toLocaleString()}
                    </td>
                    <td className="py-1 pr-2 tabular-nums">
                      {readScalarNumber(a.responseRaw, 'overall_score') ?? '—'}
                    </td>
                    <td className="py-1 pr-2 tabular-nums">
                      {row?.kind === 'done' ? row.newScore ?? '—' : statusGlyph(row)}
                    </td>
                    <td className="py-1 pr-2 tabular-nums">{deltaCell(a, row)}</td>
                    <td className="py-1 pr-2">{tierCell(a, row)}</td>
                    <td className="py-1 pr-2 tabular-nums">
                      {row?.kind === 'done' ? `${row.latencyMs}ms` : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}

function statusGlyph(row: RowState | undefined): string {
  if (!row) return '—';
  if (row.kind === 'pending') return '…';
  if (row.kind === 'running') return '⏳';
  if (row.kind === 'error') return '✕';
  return '—';
}

function deltaCell(a: SavedAttempt, row: RowState | undefined): string {
  if (!row || row.kind !== 'done') return '—';
  const oldScore = readScalarNumber(a.responseRaw, 'overall_score');
  if (oldScore === null || row.newScore === null) return '—';
  const delta = row.newScore - oldScore;
  if (delta === 0) return '0';
  return delta > 0 ? `+${delta}` : String(delta);
}

function tierCell(a: SavedAttempt, row: RowState | undefined): string {
  const oldTier = readScalarString(a.responseRaw, 'tier') ?? '—';
  if (!row || row.kind !== 'done') return oldTier;
  if (row.newTier && row.newTier !== oldTier) return `${oldTier} → ${row.newTier}`;
  return oldTier;
}

function readScalarNumber(payload: unknown, key: string): number | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const score = (payload as { score?: Record<string, unknown> }).score;
  if (!score) return null;
  const v = (score as Record<string, unknown>)[key];
  return typeof v === 'number' ? v : null;
}

function readScalarString(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const score = (payload as { score?: Record<string, unknown> }).score;
  if (!score) return null;
  const v = (score as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
}
