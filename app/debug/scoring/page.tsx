'use client';

// SPECK overnight Track 2 §debug-scoring: dev-only page for inspecting and
// replaying saved Gemini scoring attempts. Not linked from the user UI;
// the user types `/debug/scoring` directly. No auth — this is a tool,
// not a feature.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  base64ToBlob,
  clearAttempts,
  deleteAttempt,
  exportAllAsJson,
  getAttempt,
  importFromJson,
  isCaptureEnabled,
  listAttempts,
  setCaptureEnabled,
  updateNotes,
  type SavedAttempt,
} from '@/lib/debug/attemptStore';
import { scoreWithGemini } from '@/lib/scoring/gemini/client';
import { diffScalarKeys, formatCell } from './diff';

type Tab = 'video' | 'inputs' | 'request' | 'response' | 'rescore' | 'notes';

export default function DebugScoringPage() {
  const [attempts, setAttempts] = useState<SavedAttempt[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('video');
  const [captureOn, setCaptureOnState] = useState<boolean>(false);
  const [rescoreStatus, setRescoreStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'running' }
    | { kind: 'done'; response: unknown; latencyMs: number; savedId: string | null }
    | { kind: 'error'; reason: string }
  >({ kind: 'idle' });
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    const list = await listAttempts();
    setAttempts(list);
    setSelectedId((prev) => {
      if (prev && list.some((a) => a.id === prev)) return prev;
      return list[0]?.id ?? null;
    });
  }, []);

  useEffect(() => {
    setCaptureOnState(isCaptureEnabled());
    void refresh();
  }, [refresh]);

  const selected = useMemo(
    () => attempts.find((a) => a.id === selectedId) ?? null,
    [attempts, selectedId],
  );

  const handleToggleCapture = useCallback(() => {
    const next = !captureOn;
    setCaptureEnabled(next);
    setCaptureOnState(next);
  }, [captureOn]);

  const handleClearAll = useCallback(async () => {
    if (typeof window !== 'undefined' && !window.confirm('Delete all saved attempts?')) return;
    await clearAttempts();
    setRescoreStatus({ kind: 'idle' });
    await refresh();
  }, [refresh]);

  const handleDeleteSelected = useCallback(async () => {
    if (!selectedId) return;
    if (typeof window !== 'undefined' && !window.confirm('Delete this attempt?')) return;
    await deleteAttempt(selectedId);
    setSelectedId(null);
    await refresh();
  }, [selectedId, refresh]);

  const handleExport = useCallback(async () => {
    const json = await exportAllAsJson();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `groov-debug-attempts-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleImport = useCallback(
    async (file: File) => {
      const text = await file.text();
      const { imported, skipped } = await importFromJson(text);
      // eslint-disable-next-line no-alert
      window.alert(`Imported ${imported} attempt(s). Skipped ${skipped}.`);
      await refresh();
    },
    [refresh],
  );

  const handleRescore = useCallback(async () => {
    if (!selected) return;
    setRescoreStatus({ kind: 'running' });
    try {
      const attemptBlob = base64ToBlob(selected.attemptBlobBase64, selected.attemptMimeType);
      const result = await scoreWithGemini({
        attemptBlob,
        referenceVideoUrl: selected.referenceUrl,
        chunkStartMs: selected.chunkStartMs,
        chunkEndMs: selected.chunkEndMs,
        legsVisible: selected.legsVisible,
        danceId: selected.danceId,
        chunkIndex: selected.chunkIndex,
      });
      if (result.kind === 'success') {
        setRescoreStatus({
          kind: 'done',
          response: { score: result.score, latencyMs: result.latencyMs },
          latencyMs: result.latencyMs,
          savedId: null,
        });
        await refresh();
      } else {
        setRescoreStatus({ kind: 'error', reason: result.reason });
      }
    } catch (err) {
      setRescoreStatus({
        kind: 'error',
        reason: err instanceof Error ? err.message : 'unknown',
      });
    }
  }, [selected, refresh]);

  const handleNotesChange = useCallback(
    async (next: string) => {
      if (!selectedId) return;
      await updateNotes(selectedId, next);
      const refreshed = await getAttempt(selectedId);
      setAttempts((list) => list.map((a) => (a.id === selectedId && refreshed ? refreshed : a)));
    },
    [selectedId],
  );

  return (
    <main className="theme-cream flex h-full w-full flex-col bg-cream">
      <div className="border-b border-cream-deep px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-base font-bold">Scoring Debug</h1>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={captureOn}
              onChange={handleToggleCapture}
              className="h-4 w-4"
            />
            Capture attempts
          </label>
          <button
            type="button"
            onClick={handleClearAll}
            className="rounded-full bg-ink px-3 py-1 text-xs font-bold text-cream-card"
          >
            Clear all
          </button>
          <button
            type="button"
            onClick={handleExport}
            className="rounded-full bg-cream-card px-3 py-1 text-xs font-bold text-ink ring-1 ring-cream-deep"
          >
            Export all
          </button>
          <button
            type="button"
            onClick={() => importInputRef.current?.click()}
            className="rounded-full bg-cream-card px-3 py-1 text-xs font-bold text-ink ring-1 ring-cream-deep"
          >
            Import
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleImport(f);
              e.target.value = '';
            }}
          />
          <Link
            href="/debug/scoring/eval"
            className="rounded-full bg-cream-card px-3 py-1 text-xs font-bold text-ink ring-1 ring-cream-deep"
          >
            Eval →
          </Link>
          <span className="ml-auto text-xs text-ink-muted">
            {attempts.length} saved
          </span>
        </div>
      </div>

      <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
        <aside className="w-full overflow-y-auto border-b border-cream-deep md:max-w-xs md:border-b-0 md:border-r">
          {attempts.length === 0 && (
            <div className="p-4 text-sm text-ink-muted">
              No saved attempts yet. Toggle &quot;Capture attempts&quot; ON, then run a
              chunk in test mode.
            </div>
          )}
          <ul>
            {attempts.map((a) => {
              const score = readDisplayedScore(a);
              const tier = readTier(a);
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedId(a.id);
                      setRescoreStatus({ kind: 'idle' });
                      setTab('video');
                    }}
                    className={`w-full px-3 py-2 text-left text-xs ${
                      a.id === selectedId ? 'bg-coral/15' : 'hover:bg-cream-deep/50'
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-semibold">{a.danceId}</span>
                      <span className="tabular-nums text-ink-muted">
                        ch {a.chunkIndex}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <span className="tabular-nums text-ink-muted">
                        {new Date(a.savedAt).toLocaleString()}
                      </span>
                      {score !== null && (
                        <span className="rounded-full bg-ink px-2 py-0.5 text-[10px] font-bold text-cream-card">
                          {score} · {tier ?? '—'}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[10px] text-ink-dim">
                      {a.durationSource ?? 'unknown'} · {a.latencyMs}ms
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        <section className="flex flex-1 flex-col overflow-hidden">
          {!selected && (
            <div className="flex flex-1 items-center justify-center text-sm text-ink-muted">
              Select an attempt on the left.
            </div>
          )}
          {selected && (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b border-cream-deep px-4 py-2 text-xs">
                <button
                  type="button"
                  onClick={handleRescore}
                  disabled={rescoreStatus.kind === 'running'}
                  className="rounded-full bg-coral px-3 py-1 font-bold text-white disabled:opacity-50"
                >
                  {rescoreStatus.kind === 'running' ? 'Re-scoring…' : 'Re-score with current code'}
                </button>
                <button
                  type="button"
                  onClick={handleDeleteSelected}
                  className="rounded-full bg-cream-card px-3 py-1 font-bold text-ink ring-1 ring-cream-deep"
                >
                  Delete
                </button>
                <span className="ml-auto truncate text-ink-muted">{selected.id}</span>
              </div>
              <div className="flex gap-1 border-b border-cream-deep px-4 pt-2 text-xs">
                {(
                  [
                    ['video', 'Video'],
                    ['inputs', 'Inputs'],
                    ['request', 'Request'],
                    ['response', 'Response'],
                    ['rescore', 'Re-score'],
                    ['notes', 'Notes'],
                  ] as Array<[Tab, string]>
                ).map(([t, label]) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTab(t)}
                    className={`rounded-t-md px-3 py-1.5 font-medium ${
                      tab === t ? 'bg-cream-card text-ink' : 'text-ink-muted hover:text-ink'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex-1 overflow-auto p-4">
                {tab === 'video' && <VideoTab attempt={selected} />}
                {tab === 'inputs' && <InputsTab attempt={selected} />}
                {tab === 'request' && <RequestTab attempt={selected} />}
                {tab === 'response' && <ResponseTab attempt={selected} />}
                {tab === 'rescore' && (
                  <RescoreTab attempt={selected} status={rescoreStatus} />
                )}
                {tab === 'notes' && (
                  <NotesTab attempt={selected} onChange={handleNotesChange} />
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}

function readDisplayedScore(a: SavedAttempt): number | null {
  const raw = a.responseRaw as { score?: { overall_score?: unknown } } | null;
  const v = raw?.score?.overall_score;
  return typeof v === 'number' ? Math.round(v) : null;
}

function readTier(a: SavedAttempt): string | null {
  const raw = a.responseRaw as { score?: { tier?: unknown } } | null;
  const v = raw?.score?.tier;
  return typeof v === 'string' ? v : null;
}

function VideoTab({ attempt }: { attempt: SavedAttempt }) {
  const [attemptUrl, setAttemptUrl] = useState<string | null>(null);
  useEffect(() => {
    const blob = base64ToBlob(attempt.attemptBlobBase64, attempt.attemptMimeType);
    const url = URL.createObjectURL(blob);
    setAttemptUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [attempt.attemptBlobBase64, attempt.attemptMimeType]);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div>
        <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-ink-muted">
          Attempt
        </div>
        {attemptUrl ? (
          <video src={attemptUrl} controls playsInline className="w-full rounded-md bg-black" />
        ) : (
          <div className="text-sm text-ink-muted">Loading attempt…</div>
        )}
      </div>
      <div>
        <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-ink-muted">
          Reference (full source, seek to {Math.round(attempt.chunkStartMs / 1000)}s)
        </div>
        <video
          src={`${attempt.referenceUrl}#t=${(attempt.chunkStartMs / 1000).toFixed(2)},${(attempt.chunkEndMs / 1000).toFixed(2)}`}
          controls
          playsInline
          crossOrigin="anonymous"
          className="w-full rounded-md bg-black"
        />
      </div>
    </div>
  );
}

function InputsTab({ attempt }: { attempt: SavedAttempt }) {
  const inputs = {
    danceId: attempt.danceId,
    chunkIndex: attempt.chunkIndex,
    chunkStartMs: attempt.chunkStartMs,
    chunkEndMs: attempt.chunkEndMs,
    motionOnsetRefSec: attempt.motionOnsetRefSec,
    motionOnsetAttemptSec: attempt.motionOnsetAttemptSec,
    mirror: attempt.mirror,
    legsVisible: attempt.legsVisible,
    durationSource: attempt.durationSource,
    authoritativeDurationSec: attempt.authoritativeDurationSec,
    latencyMs: attempt.latencyMs,
  };
  return <PreJson value={inputs} />;
}

function RequestTab({ attempt }: { attempt: SavedAttempt }) {
  return <PreJson value={attempt.requestPayload} />;
}

function ResponseTab({ attempt }: { attempt: SavedAttempt }) {
  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-ink-muted">
          Raw Gemini JSON
        </div>
        <PreJson value={attempt.responseRaw} />
      </div>
      <div>
        <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-ink-muted">
          Deterministic layer
        </div>
        {attempt.responseDeterministic === null ? (
          <div className="text-sm text-ink-muted">
            Not recorded by this capture (the deterministic transformation happens upstream in the chunk page).
          </div>
        ) : (
          <PreJson value={attempt.responseDeterministic} />
        )}
      </div>
      <div>
        <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-ink-muted">
          Latency
        </div>
        <div className="text-sm tabular-nums">{attempt.latencyMs} ms</div>
      </div>
    </div>
  );
}

function RescoreTab({
  attempt,
  status,
}: {
  attempt: SavedAttempt;
  status:
    | { kind: 'idle' }
    | { kind: 'running' }
    | { kind: 'done'; response: unknown; latencyMs: number; savedId: string | null }
    | { kind: 'error'; reason: string };
}) {
  if (status.kind === 'idle') {
    return (
      <div className="text-sm text-ink-muted">
        Click &quot;Re-score with current code&quot; above. Result and diff will appear here.
      </div>
    );
  }
  if (status.kind === 'running') {
    return <div className="text-sm text-ink-muted">Re-scoring against /api/score-gemini…</div>;
  }
  if (status.kind === 'error') {
    return (
      <div className="text-sm text-accent-red">
        Re-score failed: {status.reason}
      </div>
    );
  }
  const rows = diffScalarKeys(attempt.responseRaw, status.response);
  return (
    <div className="space-y-4">
      <div className="text-xs text-ink-muted">
        latency: <span className="tabular-nums">{status.latencyMs} ms</span> (was{' '}
        <span className="tabular-nums">{attempt.latencyMs} ms</span>)
      </div>
      <table className="w-full text-xs">
        <thead className="text-left text-[10px] uppercase tracking-wider text-ink-muted">
          <tr>
            <th className="py-1 pr-2">Key</th>
            <th className="py-1 pr-2">Before</th>
            <th className="py-1 pr-2">After</th>
            <th className="py-1">Δ</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.key}
              className={row.changed ? 'bg-coral/10' : ''}
            >
              <td className="py-1 pr-2 font-mono text-[11px]">{row.key}</td>
              <td className="py-1 pr-2 tabular-nums">{formatCell(row.before)}</td>
              <td className="py-1 pr-2 tabular-nums">{formatCell(row.after)}</td>
              <td className="py-1">{row.changed ? '●' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div>
        <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-ink-muted">
          New response
        </div>
        <PreJson value={status.response} />
      </div>
    </div>
  );
}

function NotesTab({
  attempt,
  onChange,
}: {
  attempt: SavedAttempt;
  onChange: (next: string) => void;
}) {
  const [local, setLocal] = useState<string>(attempt.notes ?? '');
  useEffect(() => setLocal(attempt.notes ?? ''), [attempt.id, attempt.notes]);
  return (
    <textarea
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => onChange(local)}
      placeholder="Observations — what was the user doing? What did Gemini get right/wrong?"
      className="h-64 w-full resize-y rounded-md border border-cream-deep bg-cream-card p-3 text-sm focus:outline-none focus:ring-2 focus:ring-coral/40"
    />
  );
}

function PreJson({ value }: { value: unknown }) {
  return (
    <pre className="overflow-x-auto rounded-md bg-cream-card p-3 text-[11px] leading-relaxed text-ink">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
