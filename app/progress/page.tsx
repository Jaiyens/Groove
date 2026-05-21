'use client';

import CreamBottomNav from '@/components/library/CreamBottomNav';

// Placeholder. The progress tab is in the bottom nav per SPECK §1.6 — until
// the real per-skill streak / mastery overview lands, this surfaces an
// explicit "coming soon" rather than a 404. Bottom nav stays visible so the
// user can hop straight back to the library.

export default function ProgressPage() {
  return (
    <main className="theme-cream flex h-full w-full flex-col bg-cream">
      <div className="flex flex-1 flex-col items-center justify-center px-8 text-center safe-top">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-cream-card text-ink shadow-soft">
          <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M4 19V8M10 19v-6M16 19V4M22 19H2" />
          </svg>
        </div>
        <h1 className="mt-5 text-2xl font-medium tracking-tight text-ink">progress</h1>
        <p className="mt-2 max-w-[260px] text-sm text-ink-muted">
          your mastery, streaks, and per-skill breakdown will live here soon.
        </p>
      </div>
      <CreamBottomNav />
    </main>
  );
}
