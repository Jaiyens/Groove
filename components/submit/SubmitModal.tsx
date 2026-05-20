'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { submitDance, pollUntilReady } from '@/lib/dances/api';
import { isLikelyTikTokUrl } from '@/lib/tiktok/embed';
import type { DanceRecord } from '@/lib/dances/types';

interface SubmitModalProps {
  open: boolean;
  onClose: () => void;
}

type Stage =
  | { kind: 'input' }
  | { kind: 'loading'; messageIndex: number; danceId: string | null; record: DanceRecord | null }
  | { kind: 'error'; message: string };

const LOADING_MESSAGES = [
  'scanning the moves…',
  'finding the beat…',
  'breaking it into pieces…',
];

export default function SubmitModal({ open, onClose }: SubmitModalProps) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>({ kind: 'input' });
  const [url, setUrl] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) {
      // Reset when the modal closes from outside.
      abortRef.current?.abort();
      setStage({ kind: 'input' });
      setUrl('');
    }
  }, [open]);

  useEffect(() => {
    if (stage.kind !== 'loading') return;
    const t = setInterval(() => {
      setStage((s) =>
        s.kind === 'loading'
          ? { ...s, messageIndex: (s.messageIndex + 1) % LOADING_MESSAGES.length }
          : s,
      );
    }, 2500);
    return () => clearInterval(t);
  }, [stage.kind]);

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
    if (!isLikelyTikTokUrl(trimmed)) {
      setStage({ kind: 'error', message: 'That doesn’t look like a TikTok URL.' });
      return;
    }
    setStage({ kind: 'loading', messageIndex: 0, danceId: null, record: null });
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const { id } = await submitDance(trimmed);
      setStage({ kind: 'loading', messageIndex: 0, danceId: id, record: null });
      const final = await pollUntilReady(id, {
        signal: ctrl.signal,
        onTick: (r) =>
          setStage((s) => (s.kind === 'loading' ? { ...s, record: r } : s)),
      });
      if (final.status === 'failed') {
        setStage({
          kind: 'error',
          message: final.error_message ?? 'we couldn’t process that link.',
        });
        return;
      }
      router.push(`/dance/${final.id}`);
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'aborted') return;
      setStage({ kind: 'error', message });
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Submit a TikTok"
      className="theme-cream absolute inset-0 z-50 flex flex-col bg-cream"
    >
      <header className="safe-top flex items-center justify-between px-5 pt-5 pb-2">
        <button
          type="button"
          onClick={() => {
            abortRef.current?.abort();
            onClose();
          }}
          aria-label="Close"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-cream-card text-ink shadow-soft"
        >
          <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
        <div className="text-sm font-semibold uppercase tracking-[0.18em] text-coral">
          submit
        </div>
        <div className="w-10" />
      </header>

      <div className="flex flex-1 flex-col px-6 pt-8">
        {stage.kind === 'input' && (
          <InputStage
            url={url}
            setUrl={setUrl}
            onSubmit={handleSubmit}
          />
        )}
        {stage.kind === 'loading' && (
          <LoadingStage
            message={LOADING_MESSAGES[stage.messageIndex]}
            status={stage.record?.status ?? 'queued'}
          />
        )}
        {stage.kind === 'error' && (
          <ErrorStage
            message={stage.message}
            onTryAgain={() => setStage({ kind: 'input' })}
          />
        )}
      </div>
    </div>
  );
}

function InputStage({
  url,
  setUrl,
  onSubmit,
}: {
  url: string;
  setUrl: (s: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}) {
  return (
    <form onSubmit={onSubmit} className="flex flex-1 flex-col">
      <h1 className="font-serif text-[34px] leading-tight text-ink">
        paste a tiktok link
      </h1>
      <p className="mt-3 text-sm text-ink-muted">
        Groove will download it, find the beat, and break the dance into
        chunks you can practice.
      </p>
      <label className="mt-7 block">
        <span className="sr-only">TikTok URL</span>
        <input
          type="url"
          inputMode="url"
          autoFocus
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.tiktok.com/@…/video/…"
          className="w-full rounded-2xl bg-cream-card px-4 py-4 text-base text-ink placeholder:text-ink-dim shadow-soft outline-none ring-1 ring-ink/5 focus:ring-2 focus:ring-coral"
        />
      </label>
      <button
        type="submit"
        className="mt-5 inline-flex items-center justify-center gap-2 rounded-full bg-coral px-6 py-4 text-base font-semibold text-white shadow-lift active:scale-[0.98]"
      >
        submit
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 12h14M13 5l7 7-7 7" />
        </svg>
      </button>
      <p className="mt-4 text-center text-xs text-ink-muted">
        Works with public TikTok links. Processing takes about 30–60 seconds.
      </p>
    </form>
  );
}

function LoadingStage({
  message,
  status,
}: {
  message: string;
  status: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center text-center">
      <div className="relative h-24 w-24">
        <div className="absolute inset-0 rounded-full border-4 border-coral-soft" />
        <div className="absolute inset-0 animate-spin rounded-full border-4 border-transparent border-t-coral" />
      </div>
      <p className="mt-8 font-serif text-2xl text-ink">{message}</p>
      <p className="mt-2 text-xs uppercase tracking-[0.2em] text-ink-dim">
        {status}
      </p>
    </div>
  );
}

function ErrorStage({
  message,
  onTryAgain,
}: {
  message: string;
  onTryAgain: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-coral-soft text-coral-deep">
        <svg width={36} height={36} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 9v4M12 17h.01" />
          <circle cx="12" cy="12" r="10" />
        </svg>
      </div>
      <h2 className="mt-5 font-serif text-2xl text-ink">that didn’t work</h2>
      <p className="mt-2 max-w-[280px] text-sm text-ink-muted">{message}</p>
      <button
        type="button"
        onClick={onTryAgain}
        className="mt-7 inline-flex items-center gap-2 rounded-full bg-coral px-5 py-3 text-sm font-semibold text-white shadow-soft active:scale-[0.98]"
      >
        try a different link
      </button>
    </div>
  );
}
