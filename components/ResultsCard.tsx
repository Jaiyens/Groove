'use client';

// Mode B results card. Shown when a chunk run finishes. Replaces the
// "ALMOST THERE / red 18 / threshold 70" popup with a card that:
//   - scales the headline copy to the score (≥85 "Nailed it.", 70-84
//     "You got it.", 50-69 "Getting there.", <50 "Keep practicing.")
//   - color-codes the big score (green/amber/red)
//   - shows Arms / Legs / Body / Timing component sub-scores as bars
//   - lists 2-3 trouble spots with timestamp + tappable practice button
//   - primary CTA is "Drill the worst part" (routes into Mode A's
//     drill mode at the lowest-scoring window)
//   - secondary CTAs: Try again + Back to lesson
//
// All of the per-joint detail, trouble-spot detection, and timing
// derivation lives in the scoring layer (lib/scoring/scorer.ts). This
// component is a pure presentation layer over SessionScore.

import Link from 'next/link';
import { PASS_THRESHOLD } from '@/lib/mastery/chunkProgress';
import type { ComponentScores, SessionScore, TroubleSpot } from '@/lib/scoring/types';

interface ResultsCardProps {
  danceId: string;
  chunkIndex: number;
  totalChunks: number;
  finalScore: number;
  sessionScore: SessionScore | null;
  unlockedNext: boolean;
  onRetry: () => void;
}

function headlineCopy(score: number): string {
  if (score >= 85) return 'Nailed it.';
  if (score >= PASS_THRESHOLD) return 'You got it.';
  if (score >= 50) return 'Getting there.';
  return 'Keep practicing.';
}

function scoreColorClass(score: number): string {
  if (score >= PASS_THRESHOLD) return 'text-accent-green';
  if (score >= 50) return 'text-accent-amber';
  return 'text-accent-red';
}

function barColorClass(score: number): string {
  if (score >= PASS_THRESHOLD) return 'bg-accent-green';
  if (score >= 50) return 'bg-accent-amber';
  return 'bg-accent-red';
}

function formatMs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Primary "drill the worst part" target = the lowest-scoring trouble
// spot. Falls back to the chunk's first half if no trouble spot was
// flagged.
function pickWorstSpot(score: SessionScore | null): TroubleSpot | null {
  if (!score?.troubleSpots || score.troubleSpots.length === 0) return null;
  let worst = score.troubleSpots[0]!;
  for (const t of score.troubleSpots) if (t.score < worst.score) worst = t;
  return worst;
}

export default function ResultsCard({
  danceId,
  chunkIndex,
  totalChunks,
  finalScore,
  sessionScore,
  unlockedNext,
  onRetry,
}: ResultsCardProps) {
  const passed = finalScore >= PASS_THRESHOLD;
  const hasNextChunk = chunkIndex + 1 < totalChunks;
  const components = sessionScore?.components;
  const troubleSpots = sessionScore?.troubleSpots ?? [];
  const worst = pickWorstSpot(sessionScore);

  return (
    <div className="absolute inset-0 z-40 flex flex-col items-center justify-start overflow-y-auto bg-black/95 px-6 pt-8 pb-10 text-center">
      <div className="mt-2 text-xs uppercase tracking-widest text-white/55">
        {headlineCopy(finalScore)}
      </div>
      <div
        className={`mt-1 text-[120px] font-extrabold leading-none tabular-nums ${scoreColorClass(finalScore)}`}
      >
        {finalScore}
      </div>

      {passed && unlockedNext && hasNextChunk && (
        <div className="mt-2 text-sm font-bold text-accent-green">
          Chunk {chunkIndex + 2} unlocked
        </div>
      )}
      {passed && !hasNextChunk && (
        <div className="mt-2 text-sm font-bold text-accent-green">
          All chunks complete — try the full attempt
        </div>
      )}

      {components && (
        <div className="mt-7 grid w-full max-w-xs grid-cols-2 gap-3">
          <ComponentBar label="Arms" score={components.arms} />
          <ComponentBar label="Legs" score={components.legs} />
          <ComponentBar label="Body" score={components.body} />
          <ComponentBar label="Timing" score={components.timing} />
        </div>
      )}

      {troubleSpots.length > 0 && (
        <div className="mt-7 w-full max-w-xs">
          <div className="mb-2 text-[10px] uppercase tracking-widest text-white/40">
            trouble spots
          </div>
          <ul className="flex flex-col gap-2">
            {troubleSpots.map((spot) => (
              <li key={spot.startMs}>
                <Link
                  href={drillUrl(danceId, chunkIndex, spot)}
                  className="flex items-center justify-between rounded-2xl bg-white/5 px-4 py-3 text-left ring-1 ring-white/10 active:scale-[0.99]"
                >
                  <div>
                    <div className="text-sm font-semibold tabular-nums text-white">
                      at {formatMs(spot.startMs)}
                    </div>
                    <div className="text-xs text-white/60">{spot.message}</div>
                  </div>
                  <div className={`text-xs font-bold tabular-nums ${scoreColorClass(spot.score)}`}>
                    {spot.score}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-7 flex w-full max-w-xs flex-col gap-2">
        {passed ? (
          hasNextChunk ? (
            <Link
              href={`/dance/${danceId}/chunk/${chunkIndex + 1}/copy`}
              className="rounded-full bg-white py-3 text-center text-sm font-bold text-black"
            >
              Next chunk
            </Link>
          ) : (
            <Link
              href={`/dance/${danceId}/full`}
              className="rounded-full bg-white py-3 text-center text-sm font-bold text-black"
            >
              Full attempt
            </Link>
          )
        ) : worst ? (
          <Link
            href={drillUrl(danceId, chunkIndex, worst)}
            className="rounded-full bg-coral py-3 text-center text-sm font-bold text-white"
          >
            Drill the worst part
          </Link>
        ) : null}
        <button
          type="button"
          onClick={onRetry}
          className="rounded-full bg-white/10 py-3 text-sm font-semibold text-white ring-1 ring-white/15"
        >
          Try again
        </button>
        <Link
          href={`/dance/${danceId}`}
          className="py-2 text-center text-xs text-white/50"
        >
          Back to lesson
        </Link>
      </div>
    </div>
  );
}

function ComponentBar({ label, score }: { label: string; score: number }) {
  const rounded = Math.round(Math.max(0, Math.min(100, score)));
  return (
    <div className="rounded-2xl bg-white/5 p-3 ring-1 ring-white/10">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] uppercase tracking-widest text-white/60">
          {label}
        </span>
        <span className={`text-sm font-bold tabular-nums ${scoreColorClass(score)}`}>
          {rounded}
        </span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full ${barColorClass(score)}`}
          style={{ width: `${rounded}%` }}
        />
      </div>
    </div>
  );
}

function drillUrl(
  danceId: string,
  chunkIndex: number,
  spot: { startMs: number; endMs: number },
): string {
  const from = Math.max(0, Math.floor(spot.startMs));
  const to = Math.max(from + 1, Math.floor(spot.endMs));
  return `/dance/${danceId}/chunk/${chunkIndex}/copy?from=${from}&to=${to}&speed=0.5`;
}

export type { ResultsCardProps };
