'use client';

// Mode B results card. Now driven by FinalScoreView (Gemini's score is
// the headline; MediaPipe shows up as a small debug pill under the
// headline when NEXT_PUBLIC_SHOW_BOTH_SCORES=true). Falls back to the
// MediaPipe-only render when `finalView` is not passed (so the rest of
// the app — drill, Mode A, etc — still mount the card with the legacy
// SessionScore prop and render the same MediaPipe-driven view they did
// before).
//
// Hierarchy:
//   - headline copy + big score (color-tiered)
//   - debug pill + "Why are these different?" expander when validation mode
//   - Arms / Legs / Body / Timing component bars (from Gemini's components)
//   - 1-4 insight bullets (from Gemini's insights)
//   - trouble spots → tappable drill rows
//   - primary CTA (Drill / Next chunk / Full attempt) + secondary Try again
//
// Drill routing: trouble spots from Gemini come in seconds RELATIVE to the
// attempt clip; we add chunkStartMs to get absolute routine ms for the
// drill URL. The MediaPipe-fallback adapter also returns relative seconds,
// so the conversion is identical for both sources.

import { useState } from 'react';
import Link from 'next/link';
import { PASS_THRESHOLD } from '@/lib/mastery/chunkProgress';
import type { ComponentScores, SessionScore, TroubleSpot } from '@/lib/scoring/types';
import type { FinalScoreView } from '@/lib/scoring/finalScore';
import type { GeminiScore } from '@/lib/scoring/gemini/types';

interface ResultsCardProps {
  danceId: string;
  chunkIndex: number;
  totalChunks: number;
  finalScore: number;
  sessionScore: SessionScore | null;
  unlockedNext: boolean;
  onRetry: () => void;
  // New (post-Gemini): unified primary+backup view. When present, the
  // card renders Gemini's components, insights, trouble spots, and a
  // MediaPipe debug pill (when validation mode is on). When absent, the
  // card falls back to the legacy sessionScore-driven render so existing
  // call sites that don't yet pass finalView keep working.
  finalView?: FinalScoreView;
  // Absolute routine ms the chunk starts at. Required when finalView is
  // present so we can convert Gemini's relative-second trouble spots back
  // to absolute ms for the drill URL.
  chunkStartMs?: number;
}

const SHOW_BOTH_SCORES = process.env.NEXT_PUBLIC_SHOW_BOTH_SCORES === 'true';

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
  finalView,
  chunkStartMs,
}: ResultsCardProps) {
  // When the test page passes finalView, render the Gemini-driven view.
  // Otherwise stay on the legacy MediaPipe-only path so older call sites
  // (drill route, Mode A bridge, anything else mounting this card)
  // continue to work without prop churn.
  if (finalView) {
    return (
      <GeminiResultsView
        danceId={danceId}
        chunkIndex={chunkIndex}
        totalChunks={totalChunks}
        finalScore={finalScore}
        finalView={finalView}
        sessionScore={sessionScore}
        unlockedNext={unlockedNext}
        chunkStartMs={chunkStartMs ?? 0}
        onRetry={onRetry}
      />
    );
  }

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

interface GeminiResultsViewProps {
  danceId: string;
  chunkIndex: number;
  totalChunks: number;
  finalScore: number;
  finalView: FinalScoreView;
  sessionScore: SessionScore | null;
  unlockedNext: boolean;
  chunkStartMs: number;
  onRetry: () => void;
}

function GeminiResultsView({
  danceId,
  chunkIndex,
  totalChunks,
  finalScore,
  finalView,
  sessionScore,
  unlockedNext,
  chunkStartMs,
  onRetry,
}: GeminiResultsViewProps) {
  const [showCompare, setShowCompare] = useState(false);
  const primary = finalView.primary;
  const passed = finalScore >= PASS_THRESHOLD;
  const hasNextChunk = chunkIndex + 1 < totalChunks;

  // Mediapipe debug pill is only shown in validation mode. The score is
  // unaffected by the pill — Gemini's overall_score is the headline either
  // way. When finalView.source === 'mediapipe-fallback' there's nothing
  // useful to compare against (backup is null), so we hide the pill.
  const showDebugPill = SHOW_BOTH_SCORES && finalView.source === 'gemini' && sessionScore != null;
  const worstSpot = pickWorstGeminiSpot(primary.trouble_spots);

  return (
    <div className="absolute inset-0 z-40 flex flex-col items-center justify-start overflow-y-auto bg-black/95 px-6 pt-8 pb-10 text-center">
      <div className="mt-2 text-xs uppercase tracking-widest text-white/55">
        {headlineCopyForTier(primary.tier, finalScore)}
      </div>
      <div
        className={`mt-1 text-[120px] font-extrabold leading-none tabular-nums ${scoreColorClass(finalScore)}`}
      >
        {finalScore}
      </div>

      {showDebugPill && sessionScore && (
        <div className="mt-2 flex flex-col items-center gap-1">
          <div className="rounded-full bg-white/10 px-3 py-1 text-[10px] font-semibold tracking-widest text-white/55">
            MediaPipe (debug): {Math.round(sessionScore.overall)}
          </div>
          <button
            type="button"
            onClick={() => setShowCompare((v) => !v)}
            className="text-[10px] text-white/40 underline-offset-2 hover:underline"
          >
            {showCompare ? 'Hide comparison' : 'Why are these different?'}
          </button>
        </div>
      )}

      {showCompare && sessionScore && (
        <CompareTable
          gemini={primary.components}
          mediapipe={sessionScore.components ?? null}
        />
      )}

      {finalView.source === 'mediapipe-fallback' && (
        // Tiny breadcrumb for the validator — doesn't surface as an error to
        // the user, but in dev we want to know when we fell back so we can
        // diagnose Gemini reliability.
        <div className="mt-2 text-[10px] uppercase tracking-widest text-white/30">
          fallback scoring
        </div>
      )}

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

      <div className="mt-7 grid w-full max-w-xs grid-cols-2 gap-3">
        <ComponentBar label="Arms" score={primary.components.arms} />
        <ComponentBar
          label="Legs"
          score={primary.components.legs}
          note={finalView.legsVisible === false ? '(upper body only)' : null}
        />
        <ComponentBar label="Body" score={primary.components.body} />
        <ComponentBar label="Timing" score={primary.components.timing} />
      </div>

      {primary.insights.length > 0 && (
        <ul className="mt-6 w-full max-w-xs space-y-1.5 text-left">
          {primary.insights.map((insight, i) => (
            <li key={i} className="rounded-2xl bg-white/5 px-4 py-2 text-xs leading-relaxed text-white/80 ring-1 ring-white/10">
              {insight}
            </li>
          ))}
        </ul>
      )}

      {primary.trouble_spots.length > 0 && (
        <div className="mt-6 w-full max-w-xs">
          <div className="mb-2 text-[10px] uppercase tracking-widest text-white/40">
            trouble spots
          </div>
          <ul className="flex flex-col gap-2">
            {primary.trouble_spots.map((spot, i) => (
              <li key={i}>
                <Link
                  href={drillUrlForGeminiSpot(danceId, chunkIndex, spot, chunkStartMs)}
                  className="flex items-center justify-between rounded-2xl bg-white/5 px-4 py-3 text-left ring-1 ring-white/10 active:scale-[0.99]"
                >
                  <div className="flex-1 pr-3">
                    <div className="text-sm font-semibold tabular-nums text-white">
                      at {formatSeconds(spot.start_sec)}
                    </div>
                    <div className="text-xs text-white/70">{spot.what_happened}</div>
                    {spot.fix && (
                      <div className="mt-0.5 text-[11px] text-white/45">{spot.fix}</div>
                    )}
                  </div>
                  <div className="text-[10px] font-bold uppercase tracking-widest text-white/55">
                    {spot.severity}
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
        ) : worstSpot ? (
          <Link
            href={drillUrlForGeminiSpot(danceId, chunkIndex, worstSpot, chunkStartMs)}
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

function CompareTable({
  gemini,
  mediapipe,
}: {
  gemini: GeminiScore['components'];
  mediapipe: ComponentScores | null;
}) {
  const rows: Array<['Arms' | 'Legs' | 'Body' | 'Timing', number, number | null]> = [
    ['Arms', gemini.arms, mediapipe?.arms ?? null],
    ['Legs', gemini.legs, mediapipe?.legs ?? null],
    ['Body', gemini.body, mediapipe?.body ?? null],
    ['Timing', gemini.timing, mediapipe?.timing ?? null],
  ];
  return (
    <div className="mt-3 w-full max-w-xs rounded-2xl bg-white/5 p-3 ring-1 ring-white/10">
      <div className="grid grid-cols-3 gap-2 text-[10px] uppercase tracking-widest text-white/40">
        <span className="text-left">Component</span>
        <span className="text-right">Gemini</span>
        <span className="text-right">MediaPipe</span>
      </div>
      <ul className="mt-1 flex flex-col gap-0.5">
        {rows.map(([label, g, mp]) => (
          <li key={label} className="grid grid-cols-3 gap-2 text-xs tabular-nums">
            <span className="text-left text-white/75">{label}</span>
            <span className="text-right text-white">{Math.round(g)}</span>
            <span className="text-right text-white/55">{mp != null ? Math.round(mp) : '—'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function headlineCopyForTier(tier: GeminiScore['tier'], score: number): string {
  // Gemini owns the tier; we only need to map it to a one-line headline
  // that matches the existing Mode B voice.
  if (tier === 'NOT_DANCING') return 'Was that a dance?';
  if (tier === 'GROOVY') return 'Nailed it.';
  if (tier === 'SOLID') return 'You got it.';
  if (score >= 50) return 'Getting there.';
  return 'Keep practicing.';
}

function formatSeconds(sec: number): string {
  const totalSec = Math.max(0, Math.floor(sec));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function pickWorstGeminiSpot(
  spots: GeminiScore['trouble_spots'],
): GeminiScore['trouble_spots'][number] | null {
  if (spots.length === 0) return null;
  // Severity-major first, then major→moderate→minor; within tier, earlier in
  // the clip wins (gives the user a chronological narrative to fix).
  const rank: Record<GeminiScore['trouble_spots'][number]['severity'], number> = {
    major: 0,
    moderate: 1,
    minor: 2,
  };
  let worst = spots[0]!;
  for (const s of spots) {
    if (rank[s.severity] < rank[worst.severity]) worst = s;
    else if (rank[s.severity] === rank[worst.severity] && s.start_sec < worst.start_sec) worst = s;
  }
  return worst;
}

function drillUrlForGeminiSpot(
  danceId: string,
  chunkIndex: number,
  spot: GeminiScore['trouble_spots'][number],
  chunkStartMs: number,
): string {
  // Spot times are seconds relative to the attempt clip; add chunkStartMs
  // to convert back to absolute routine ms that the drill route expects.
  const startMs = Math.max(0, Math.floor(chunkStartMs + spot.start_sec * 1000));
  const endMs = Math.max(startMs + 1, Math.floor(chunkStartMs + spot.end_sec * 1000));
  return `/dance/${danceId}/chunk/${chunkIndex}/copy?from=${startMs}&to=${endMs}&speed=0.5`;
}

function ComponentBar({
  label,
  score,
  note,
}: {
  label: string;
  score: number;
  // Small contextual subtitle under the label — used to explain a
  // defaulted leg score when the user filmed upper-body only (SPECK
  // §windowing-fix). Null when no annotation applies.
  note?: string | null;
}) {
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
      {note && (
        <div className="mt-0.5 text-[9px] uppercase tracking-widest text-white/35">
          {note}
        </div>
      )}
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
