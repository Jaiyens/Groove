'use client';

import type { CorrectionHint } from '@/lib/scoring/types';

interface CorrectionToastProps {
  hint: CorrectionHint | null;
}

export default function CorrectionToast({ hint }: CorrectionToastProps) {
  if (!hint) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-full bg-black/70 backdrop-blur px-3 py-1.5 text-xs font-bold uppercase tracking-wide ring-1 ring-white/10"
    >
      {hint.message}
    </div>
  );
}
