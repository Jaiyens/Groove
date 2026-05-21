'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import CreamBottomNav from '@/components/library/CreamBottomNav';
import { clearFramingCalibrated } from '@/lib/pose/framingCalibration';

// Placeholder profile. The only real wired action right now is
// "re-calibrate framing" per SPECK §4 — clears localStorage and routes
// to the onboarding screen.

export default function ProfilePage() {
  const router = useRouter();

  const recalibrate = useCallback(() => {
    clearFramingCalibrated();
    router.push('/onboarding/frame-check?return=/profile');
  }, [router]);

  return (
    <main className="theme-cream flex h-full w-full flex-col bg-cream">
      <div className="flex flex-1 flex-col items-center px-8 pt-16 text-center safe-top">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-cream-card text-ink shadow-soft">
          <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21a8 8 0 0 1 16 0" />
          </svg>
        </div>
        <h1 className="mt-5 text-2xl font-medium tracking-tight text-ink">profile</h1>
        <p className="mt-2 max-w-[260px] text-sm text-ink-muted">
          account, settings, and progress will live here soon.
        </p>

        <section className="mt-10 w-full max-w-sm rounded-2xl bg-cream-card p-4 text-left shadow-soft ring-1 ring-cream-deep">
          <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-ink-muted">
            camera
          </div>
          <button
            type="button"
            onClick={recalibrate}
            className="mt-2 flex w-full items-center justify-between rounded-xl bg-cream px-3 py-3 text-sm text-ink ring-1 ring-cream-deep active:bg-cream-deep"
          >
            <span>re-calibrate framing</span>
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>
        </section>
      </div>
      <CreamBottomNav />
    </main>
  );
}
