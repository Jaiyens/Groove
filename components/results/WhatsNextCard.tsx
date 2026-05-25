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

interface Props {
  danceId: string;
  danceName: string;
  weakestSkill?: SkillNode | null;
  onRetry: () => void;
}

export default function WhatsNextCard({
  danceId,
  danceName,
  weakestSkill,
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
