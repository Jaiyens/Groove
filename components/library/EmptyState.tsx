'use client';

interface EmptyStateProps {
  onSubmit: () => void;
  unconfigured?: boolean;
}

export default function EmptyState({ onSubmit, unconfigured }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center px-2 pt-8 text-center">
      <div className="mb-6 flex h-32 w-32 items-center justify-center rounded-full bg-cream-deep">
        <svg width={64} height={64} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="text-ink-muted" aria-hidden>
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </svg>
      </div>
      <h2 className="text-2xl font-medium leading-tight tracking-tight text-ink">
        your library is empty
      </h2>
      <p className="mt-3 max-w-[260px] text-sm text-ink-muted">
        paste a tiktok link and groove will break it down into chunks you
        can practice and score against your camera.
      </p>
      {unconfigured && (
        <p className="mt-4 rounded-xl border border-cream-deep bg-cream-card px-3 py-2 text-xs text-ink-muted">
          heads up: Supabase isn’t configured yet. See SETUP_TODO.md.
        </p>
      )}
      <button
        type="button"
        onClick={onSubmit}
        className="mt-7 inline-flex items-center gap-2 rounded-full bg-ink px-6 py-3.5 text-base font-medium text-cream-card shadow-lift active:scale-[0.98]"
      >
        submit your first tiktok
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 12h14M13 5l7 7-7 7" />
        </svg>
      </button>
    </div>
  );
}
