'use client';

// Shown when a dance row is queued / processing / failed. Polls /api/dances/:id
// in the background so the page transitions to ready automatically.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { fetchDance } from '@/lib/dances/api';
import type { DanceRecord } from '@/lib/dances/types';

interface ProcessingStateProps {
  initial: DanceRecord;
}

export default function ProcessingState({ initial }: ProcessingStateProps) {
  const router = useRouter();
  const [record, setRecord] = useState<DanceRecord>(initial);

  useEffect(() => {
    if (record.status === 'ready') {
      router.refresh();
      return;
    }
    if (record.status === 'failed') return;
    const interval = setInterval(async () => {
      try {
        const r = await fetchDance(record.id);
        if (r) setRecord(r);
        if (r?.status === 'ready') router.refresh();
      } catch {
        // keep retrying
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [record.id, record.status, router]);

  if (record.status === 'failed') {
    return (
      <main className="theme-cream flex h-full w-full flex-col bg-cream">
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-coral-soft text-coral-deep">
            <svg width={32} height={32} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="12" r="10" />
              <path d="M12 9v4M12 17h.01" />
            </svg>
          </div>
          <h1 className="mt-5 font-serif text-2xl text-ink">we couldn’t process that</h1>
          <p className="mt-2 max-w-[280px] text-sm text-ink-muted">
            {record.error_message ?? 'something broke during pose extraction.'}
          </p>
          <a
            href="/"
            className="mt-7 inline-flex items-center gap-2 rounded-full bg-coral px-5 py-3 text-sm font-semibold text-white"
          >
            back to library
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="theme-cream flex h-full w-full flex-col bg-cream">
      <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
        <div className="relative h-24 w-24">
          <div className="absolute inset-0 rounded-full border-4 border-coral-soft" />
          <div className="absolute inset-0 animate-spin rounded-full border-4 border-transparent border-t-coral" />
        </div>
        <h1 className="mt-7 font-serif text-2xl text-ink">getting your dance ready</h1>
        <p className="mt-2 text-xs uppercase tracking-[0.2em] text-ink-dim">
          {record.status}
        </p>
        <p className="mt-4 max-w-[280px] text-sm text-ink-muted">
          We’re downloading the clip, finding the beat, and breaking it into
          chunks. This usually takes 30–60 seconds.
        </p>
      </div>
    </main>
  );
}
