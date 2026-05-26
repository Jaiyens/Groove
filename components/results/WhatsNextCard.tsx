'use client';

// Card 5 of the results carousel — the action stack.
//
// All three navigation CTAs use router.push directly instead of
// <Link>. Pointer-capture from the carousel swipe handler used to
// eat the link's native click on iOS, leaving the user staring at
// dead navigation. Going through onClick + router.push fires through
// React's synthetic event system, which never gets eaten.

import { useRouter } from 'next/navigation';
import type { SkillNode } from '@/lib/graph/types';
import type { TierCrossing } from '@/lib/mastery/useRecordDanceAttempt';

interface Props {
  danceId: string;
  danceName: string;
  weakestSkill?: SkillNode | null;
  // When non-null, a small ambient line above the CTAs marks the
  // skill that just crossed a mastery tier. Fires at most once per
  // attempt (40→60 "getting there", 60→80 "dialed in", 80 wins).
  tierCrossing?: TierCrossing | null;
  onRetry: () => void;
}

export default function WhatsNextCard({
  danceId,
  danceName,
  weakestSkill,
  tierCrossing,
  onRetry,
}: Props) {
  const router = useRouter();
  return (
    <section className="flex h-full flex-col">
      <div className="inline-flex w-fit items-center gap-1.5 rounded-full bg-ink/10 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-ink-muted">
        what&apos;s next
      </div>
      <h2 className="mt-3 text-2xl font-semibold leading-tight text-ink">
        Where do you want to go?
      </h2>
      <p className="mt-2 text-sm leading-snug text-ink-muted">
        You can run {danceName} again to chase a higher score, dig into the
        weak skill on its own, or pick something new from the library.
      </p>

      {tierCrossing && <TierCrossingLine crossing={tierCrossing} />}

      <div className="mt-6 flex flex-col gap-3">
        <button
          type="button"
          onClick={onRetry}
          className="rounded-full bg-ink px-5 py-4 text-sm font-bold uppercase tracking-[0.18em] text-cream-card active:scale-[0.99]"
        >
          try this dance again
        </button>

        {weakestSkill && (
          <button
            type="button"
            onClick={() =>
              router.push(`/drill/${weakestSkill.id}?from=dance:${danceId}`)
            }
            className="block truncate rounded-full bg-cream-card px-5 py-4 text-center text-sm font-bold uppercase tracking-[0.18em] text-ink ring-1 ring-cream-deep active:scale-[0.99]"
          >
            drill {weakestSkill.name.toLowerCase()}
          </button>
        )}

        <button
          type="button"
          onClick={() => router.push(`/dance/${danceId}`)}
          className="rounded-full bg-cream-card px-5 py-4 text-center text-sm font-bold uppercase tracking-[0.18em] text-ink ring-1 ring-cream-deep active:scale-[0.99]"
        >
          back to the lesson
        </button>

        <button
          type="button"
          onClick={() => router.push('/')}
          className="rounded-full bg-cream-card px-5 py-4 text-center text-sm font-bold uppercase tracking-[0.18em] text-ink ring-1 ring-cream-deep active:scale-[0.99]"
        >
          back to library
        </button>
      </div>
    </section>
  );
}

function TierCrossingLine({ crossing }: { crossing: TierCrossing }) {
  const verdict = crossing.tier === 'dialed-in' ? 'dialed in' : 'getting there';
  const accent =
    crossing.tier === 'dialed-in'
      ? 'text-accent-green'
      : 'text-accent-amber';
  return (
    <div className="mt-5 flex items-baseline gap-2 rounded-2xl bg-cream-card px-4 py-3 ring-1 ring-cream-deep">
      <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-ink-muted">
        skill tightened
      </span>
      <span className="text-sm text-ink">
        {crossing.skill.name.toLowerCase()}:
      </span>
      <span className={`text-sm font-semibold ${accent}`}>{verdict}</span>
    </div>
  );
}
