'use client';

// Pick-a-dancer screen. Only reachable when the worker flagged the dance
// with requires_dancer_pick=true (top lead_score within PICK_AMBIGUITY_GAP
// of the second). Shows one card per detected person — their thumbnail
// plus a small lead-score number — and POSTs the choice back to
// /api/dances/:id/dancer. Same screen is also reachable via the "change
// dancer" link on the lesson overview for multi-person dances.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { fetchDance } from '@/lib/dances/api';
import type { DanceRecord } from '@/lib/dances/types';

interface PageProps {
  params: { danceId: string };
}

export default function PickDancerPage({ params }: PageProps) {
  const router = useRouter();
  const search = useSearchParams();
  const force = search.get('change') === '1';
  const [record, setRecord] = useState<DanceRecord | null>(null);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchDance(params.danceId).then((r) => {
      if (cancelled) return;
      if (!r) {
        router.replace('/');
        return;
      }
      setRecord(r);
    });
    return () => {
      cancelled = true;
    };
  }, [params.danceId, router]);

  useEffect(() => {
    if (!record) return;
    // No multi-person data — there's nothing to pick. Skip the screen.
    const thumbs = record.person_thumbnails ?? {};
    const ids = Object.keys(thumbs);
    if (ids.length < 2 && !force) {
      router.replace(`/dance/${record.id}`);
    }
  }, [record, router, force]);

  async function choose(personId: string) {
    if (!record) return;
    setSubmitting(personId);
    setError(null);
    try {
      const res = await fetch(`/api/dances/${record.id}/dancer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ person_id: personId }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `pick failed: ${res.status}`);
      }
      router.replace(`/dance/${record.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(null);
    }
  }

  if (!record) {
    return (
      <main className="theme-cream flex h-full items-center justify-center bg-cream text-ink-muted">
        Loading…
      </main>
    );
  }

  const thumbs = record.person_thumbnails ?? {};
  const ids = Object.keys(thumbs);
  const current = record.auto_selected_person_id;

  return (
    <main className="theme-cream flex h-full w-full flex-col bg-cream">
      <header className="safe-top flex items-center gap-3 px-5 pt-5 pb-3">
        <button
          type="button"
          onClick={() => {
            if (typeof window !== 'undefined' && window.history.length > 1) {
              router.back();
            } else {
              router.push(`/dance/${record.id}`);
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
          pick a dancer
        </div>
        <div className="w-10" aria-hidden />
      </header>

      <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-8">
        <p className="text-sm text-ink-muted">
          we spotted more than one person in this video. tap the dancer
          you want to learn from.
        </p>

        {error && (
          <div className="mt-4 rounded-2xl bg-cream-card px-4 py-3 text-sm text-accent-red ring-1 ring-cream-deep">
            {error}
          </div>
        )}

        <ul className="mt-6 grid grid-cols-2 gap-3">
          {ids.map((id) => {
            const isCurrent = id === current;
            const isSubmitting = submitting === id;
            return (
              <li key={id}>
                <button
                  type="button"
                  disabled={submitting !== null}
                  onClick={() => choose(id)}
                  className={`group relative block w-full overflow-hidden rounded-2xl bg-cream-card text-left shadow-soft ring-1 transition-transform active:scale-[0.99] ${
                    isCurrent ? 'ring-coral' : 'ring-cream-deep'
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={thumbs[id]}
                    alt={`dancer ${id}`}
                    className="aspect-[3/4] w-full object-cover"
                  />
                  <div className="px-3 py-2.5">
                    <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-ink-muted">
                      dancer {id}
                    </div>
                    <div className="mt-0.5 text-sm font-medium text-ink">
                      {isCurrent ? 'currently selected' : 'tap to learn'}
                    </div>
                  </div>
                  {isSubmitting && (
                    <div className="absolute inset-0 flex items-center justify-center bg-cream/80">
                      <div className="h-6 w-6 animate-spin rounded-full border-2 border-ink/20 border-t-ink" />
                    </div>
                  )}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="mt-6">
          <Link
            href={`/dance/${record.id}`}
            className="block py-2 text-center text-sm text-ink-muted"
          >
            keep current selection
          </Link>
        </div>
      </div>
    </main>
  );
}
