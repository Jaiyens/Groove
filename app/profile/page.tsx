'use client';

import CreamBottomNav from '@/components/library/CreamBottomNav';

// Placeholder. Same rationale as /progress — the profile tab in the bottom
// nav needs a real route, even if the real settings / account surface is
// not built yet.

export default function ProfilePage() {
  return (
    <main className="theme-cream flex h-full w-full flex-col bg-cream">
      <div className="flex flex-1 flex-col items-center justify-center px-8 text-center safe-top">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-cream-card text-ink shadow-soft">
          <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21a8 8 0 0 1 16 0" />
          </svg>
        </div>
        <h1 className="mt-5 text-2xl font-medium tracking-tight text-ink">profile</h1>
        <p className="mt-2 max-w-[260px] text-sm text-ink-muted">
          account, settings, and camera-framing re-calibration will live
          here soon.
        </p>
      </div>
      <CreamBottomNav />
    </main>
  );
}
