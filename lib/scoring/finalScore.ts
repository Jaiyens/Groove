// Final-score view: unifies the two grading sources behind a single
// shape so the results UI doesn't have to know which one won.
//
// Source = 'gemini' is the headline path (success). Source =
// 'mediapipe-fallback' fires when Gemini timed out / errored / schema-
// failed. In both cases `.primary` is GeminiScore-shaped so the
// ResultsCard renders the same JSX either way.
//
// Drill-mode routing reads `.primary.trouble_spots`. For the
// mediapipe-fallback case the spots are stubbed from MediaPipe's
// existing per-joint trouble-spot output — quality is lower but the
// loop is unbroken (no UI-empty state).
//
// Time-base note: Gemini sees only the attempt clip, so its
// `start_sec` / `end_sec` are relative to the attempt's start (0..clipDur).
// MediaPipe's troubleSpots use absolute routine ms. To route drills we
// need absolute routine ms; the adapter takes `chunkStartMs` and the
// drill-URL builder in the results card adds it back.

import type { SessionScore } from '@/lib/scoring/types';
import type { GeminiResult } from '@/lib/scoring/gemini/client';
import type { GeminiScore, GeminiBodyPart, GeminiTier } from '@/lib/scoring/gemini/types';
import type { JointName } from '@/lib/pose/types';

export type FinalScoreSource = 'gemini' | 'mediapipe-fallback';

export interface FinalScoreView {
  primary: GeminiScore;
  backup: SessionScore | null;
  source: FinalScoreSource;
}

const ARM_JOINTS: ReadonlyArray<JointName> = [
  'left_elbow',
  'right_elbow',
  'left_shoulder',
  'right_shoulder',
];
const LEG_JOINTS: ReadonlyArray<JointName> = [
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
];

function bodyPartForJoint(joint: JointName | null | undefined): GeminiBodyPart {
  if (!joint) return 'body';
  if (ARM_JOINTS.includes(joint)) return 'arms';
  if (LEG_JOINTS.includes(joint)) return 'legs';
  return 'body';
}

export function tierForOverall(score: number): GeminiTier {
  if (score >= 85) return 'GROOVY';
  if (score >= 65) return 'SOLID';
  if (score >= 40) return 'SHAKY';
  return 'NOT_DANCING';
}

// Map a MediaPipe SessionScore to the GeminiScore shape. Quality
// (insights, is_actually_dancing canary, trouble-spot fix copy) is
// inferior to a real Gemini response by design — this exists so the
// UI keeps working when Gemini fails. Per SPECK §Hard rule 1, callouts
// don't feed into this either; it's a pure projection of MediaPipe.
export function mediapipeFinalToGeminiShape(
  session: SessionScore,
  chunkStartMs: number,
): GeminiScore {
  const overall = Math.round(Math.max(0, Math.min(100, session.overall)));
  const components = session.components ?? {
    arms: overall,
    legs: overall,
    body: overall,
    timing: overall,
  };
  const tier = tierForOverall(overall);

  const spots = (session.troubleSpots ?? []).slice(0, 5).map((spot) => {
    const gap = Math.max(0, overall - spot.score);
    const severity: GeminiScore['trouble_spots'][number]['severity'] =
      gap >= 20 ? 'major' : gap >= 10 ? 'moderate' : 'minor';
    // Convert absolute routine ms → seconds relative to the attempt
    // clip start (chunkStartMs). HoldingScreen plays the attempt clip
    // and drill routing in ResultsCard adds chunkStartMs back when
    // building the drill URL.
    const startSec = Math.max(0, (spot.startMs - chunkStartMs) / 1000);
    const endSec = Math.max(startSec + 0.1, (spot.endMs - chunkStartMs) / 1000);
    return {
      start_sec: startSec,
      end_sec: endSec,
      body_part: bodyPartForJoint(spot.worstJoint),
      severity,
      what_happened: spot.message || `${spot.worstJoint ?? 'movement'} off`,
      fix: 'Slow it down and match the reference shape.',
    };
  });

  // Insights: lead with the lowest-scoring component, then mention the
  // worst trouble spot if we have one. Don't fabricate — at most two
  // insights.
  const insights: string[] = [];
  const compEntries: Array<[string, number]> = [
    ['arms', components.arms],
    ['legs', components.legs],
    ['body', components.body],
    ['timing', components.timing],
  ];
  compEntries.sort((a, b) => a[1] - b[1]);
  const [worstComp, worstCompScore] = compEntries[0]!;
  if (worstCompScore < overall - 5) {
    insights.push(`Your ${worstComp} score was the weakest this run.`);
  } else {
    insights.push('Solid overall — keep refining the details.');
  }
  if (spots[0]) {
    insights.push(`Watch the moment around ${spots[0].start_sec.toFixed(1)}s.`);
  }

  return {
    is_actually_dancing: overall >= 40,
    overall_score: overall,
    tier,
    components: {
      arms: Math.round(components.arms),
      legs: Math.round(components.legs),
      body: Math.round(components.body),
      timing: Math.round(components.timing),
    },
    insights: insights.length > 0 ? insights : ['Keep practicing.'],
    trouble_spots: spots,
  };
}

export function buildFinalScoreView(
  geminiResult: GeminiResult,
  mediapipeFinal: SessionScore,
  chunkStartMs: number,
): FinalScoreView {
  if (geminiResult.kind === 'success') {
    return {
      primary: geminiResult.score,
      backup: mediapipeFinal,
      source: 'gemini',
    };
  }
  return {
    primary: mediapipeFinalToGeminiShape(mediapipeFinal, chunkStartMs),
    backup: null,
    source: 'mediapipe-fallback',
  };
}
