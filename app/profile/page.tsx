'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import CreamBottomNav from '@/components/library/CreamBottomNav';
import { clearFramingCalibrated } from '@/lib/pose/framingCalibration';
import { getPracticeStats, type PracticeStats } from '@/lib/practiceStats';

export default function ProfilePage() {
  const router = useRouter();
  const [stats, setStats] = useState<PracticeStats | null>(null);

  const recalibrate = useCallback(() => {
    clearFramingCalibrated();
    router.push('/onboarding/frame-check?return=/profile');
  }, [router]);

  useEffect(() => {
    const refresh = () => setStats(getPracticeStats());
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  return (
    <main className="theme-cream flex h-full w-full flex-col bg-cream">
      <div className="flex flex-1 flex-col items-center overflow-y-auto px-8 pt-16 pb-8 text-center safe-top">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-cream-card text-ink shadow-soft">
          <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21a8 8 0 0 1 16 0" />
          </svg>
        </div>
        <h1 className="mt-5 text-2xl font-medium tracking-tight text-ink">profile</h1>

        <section className="mt-8 w-full max-w-sm rounded-[28px] bg-cream-card p-5 text-left shadow-soft ring-1 ring-cream-deep">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-ink-muted">
                your practice
              </div>
              <h2 className="mt-1 text-xl font-medium tracking-tight text-ink">
                {stats?.hasActivity ? 'nice momentum' : 'ready when you are'}
              </h2>
            </div>
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-cream-deep text-ink">
              <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M4 19V8" />
                <path d="M10 19v-6" />
                <path d="M16 19V4" />
                <path d="M22 19H2" />
              </svg>
            </div>
          </div>

          {!stats && (
            <div className="mt-5 h-20 animate-pulse rounded-2xl bg-cream" aria-hidden />
          )}

          {stats && !stats.hasActivity && (
            <p className="mt-5 rounded-2xl bg-cream px-4 py-4 text-sm leading-6 text-ink-muted ring-1 ring-cream-deep">
              start a dance and your stats will show up here.
            </p>
          )}

          {stats?.hasActivity && (
            <div className="mt-5 grid grid-cols-3 gap-2">
              <PracticeStat label="dances started" value={stats.totalDancesStarted} />
              <PracticeStat label="chunks completed" value={stats.totalChunksCompleted} />
              <PracticeStat label="days active" value={stats.daysActive} />
            </div>
          )}
        </section>

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

function PracticeStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl bg-cream px-3 py-3 ring-1 ring-cream-deep">
      <div className="text-2xl font-medium leading-none tabular-nums text-ink">
        {value}
      </div>
      <div className="mt-2 text-[10px] font-medium uppercase leading-tight tracking-[0.12em] text-ink-muted">
        {label}
      </div>
    </div>
  );
}
