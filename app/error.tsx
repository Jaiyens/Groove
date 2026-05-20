'use client';

import { useEffect } from 'react';
import Link from 'next/link';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (typeof console !== 'undefined') console.error(error);
  }, [error]);

  return (
    <main className="flex h-full w-full flex-col items-center justify-center p-8 text-center">
      <div className="text-2xl font-bold text-accent-red">Something snapped.</div>
      <p className="mt-3 max-w-xs text-sm text-text-muted">
        {error.message || 'Unknown error.'}
      </p>
      <div className="mt-6 flex gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded-full bg-white px-5 py-2.5 text-sm font-bold text-black"
        >
          Try again
        </button>
        <Link
          href="/"
          className="rounded-full bg-bg-card px-5 py-2.5 text-sm font-bold text-white ring-1 ring-white/10"
        >
          Home
        </Link>
      </div>
    </main>
  );
}
