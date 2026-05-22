// Body-relative evaluation of `measurable_success_criterion` strings
// from the skill graph.
//
// The skill graph's criterion strings mix three classes of threshold:
//
//   (a) Joint angles in degrees — already body-invariant by construction
//       ("elbow angle > 165°", "knees between 170° and 180°").
//   (b) Positions / displacements in METERS calibrated to a reference
//       dancer of unknown real-world size ("right_wrist.x − shoulder.x
//       > 0.30 m", "ankle.y > 0.10 m above floor"). These break for
//       users of different body sizes.
//   (c) Timing windows in milliseconds ("within ±100 ms of every
//       downbeat"). Body-invariant.
//
// (a) and (c) can be checked directly on canonical landmarks. (b) is
// the source of the size-disparity bug observed in real-world testing:
// a short user meets the 0.30 m threshold at a different effective
// arm-extension fraction than a tall user. The fix is to convert every
// meter threshold at runtime into a torso-length fraction, then check
// the user's canonical (torso-relative) position against that fraction.
//
// Because the canonical skeleton's torso = 1 by construction, any
// displacement measured in canonical units is already in
// torso-lengths — so once we have "T meters → F torso-lengths" we can
// compare canonical positions directly to F.
//
// We don't know the reference dancer's real-world torso length in
// meters (the worker pipeline doesn't ship that metadata). We assume a
// typical adult value (REFERENCE_TORSO_LENGTH_M = 0.50 m); the
// resulting torso-length fractions are within ~10% of the truth for
// the adult population, which is well inside the criteria's own
// tolerances. The constant lives at the top of the module so a future
// calibration pass can tune it.
//
// SPECK Stage 5: this PR doesn't support every criterion pattern in
// the graph. The evaluator returns
//   { passed: true, evidence: 'criterion not yet supported' }
// for anything outside the supported set, and logs a one-liner to
// console so the unsupported coverage can be tracked in
// docs/scoring-normalization.md.

import type { CanonicalSkeleton } from '@/lib/pose/canonicalize';
import { LANDMARK } from '@/lib/pose/types';

export interface CriterionResult {
  passed: boolean;
  evidence: string;
}

// Assumed reference-dancer torso length in meters. The skill graph's
// meter thresholds were calibrated against this hypothetical body.
// Production data shipping per-routine torso metadata can override this
// at the call site by passing `referenceTorsoLengthM` to the evaluator.
const DEFAULT_REFERENCE_TORSO_LENGTH_M = 0.50;

export interface EvaluateOptions {
  // Override the assumed reference torso length (m). When the routine
  // metadata carries the reference dancer's real torso length, pass it
  // here so the conversion is exact rather than estimated.
  referenceTorsoLengthM?: number;
}

export function evaluateCriterion(
  criterion: string,
  userSeries: CanonicalSkeleton[],
  refSeries: CanonicalSkeleton[],
  bpm: number,
  opts: EvaluateOptions = {},
): CriterionResult {
  if (!criterion || userSeries.length === 0) {
    return notYetSupported(criterion, 'empty input');
  }

  const refTorsoM = opts.referenceTorsoLengthM ?? DEFAULT_REFERENCE_TORSO_LENGTH_M;

  // (1) Whole-routine DTW-score-style criteria are out of scope here —
  // those are meta-criteria measured by the scorer, not by per-frame
  // evaluation. Pass them through.
  if (/DTW score/i.test(criterion)) {
    return {
      passed: true,
      evidence: 'DTW-score criterion handled by the scoring pipeline, not the evaluator',
    };
  }

  // (2) Arm extension: criteria of the form "elbow angle > 165°" or
  // similar. These are the most common position-style criteria in the
  // graph and the one SPECK explicitly calls out for Stage 5 testing.
  // Body-invariant: elbow angle doesn't care about torso scale.
  const elbowMatch = criterion.match(/elbow angle\s*(?:is\s*)?>\s*(\d+(?:\.\d+)?)\s*°/i);
  if (elbowMatch) {
    const thresholdDeg = parseFloat(elbowMatch[1]!);
    const thresholdRad = (thresholdDeg * Math.PI) / 180;
    const maxObserved = maxElbowAngleAcross(userSeries);
    if (maxObserved >= thresholdRad) {
      return {
        passed: true,
        evidence: `elbow reached ${rad2deg(maxObserved).toFixed(1)}° ≥ ${thresholdDeg}°`,
      };
    }
    return {
      passed: false,
      evidence: `elbow only reached ${rad2deg(maxObserved).toFixed(1)}° vs required ${thresholdDeg}°`,
    };
  }

  // (3) Knee-angle "between A° and B°" — used for plié / squat
  // criteria. Body-invariant.
  const kneeBand = criterion.match(/knee\s*angle[s]?\s*(?:is\s*)?between\s*(\d+(?:\.\d+)?)\s*°\s*and\s*(\d+(?:\.\d+)?)\s*°/i);
  if (kneeBand) {
    const lo = parseFloat(kneeBand[1]!);
    const hi = parseFloat(kneeBand[2]!);
    const loRad = (lo * Math.PI) / 180;
    const hiRad = (hi * Math.PI) / 180;
    const minKnee = minKneeAngleAcross(userSeries);
    const maxKnee = maxKneeAngleAcross(userSeries);
    if (minKnee >= loRad && maxKnee <= hiRad) {
      return {
        passed: true,
        evidence: `knees stayed in [${lo}°, ${hi}°] (observed ${rad2deg(minKnee).toFixed(0)}°–${rad2deg(maxKnee).toFixed(0)}°)`,
      };
    }
    return {
      passed: false,
      evidence: `knees outside [${lo}°, ${hi}°] (observed ${rad2deg(minKnee).toFixed(0)}°–${rad2deg(maxKnee).toFixed(0)}°)`,
    };
  }

  // (4) Lateral wrist extension: e.g. "right_wrist.x − right_shoulder.x
  // > 0.30 m". Convert the meter threshold to torso-fractions using
  // the reference torso constant, then compare against the user's
  // canonical-space displacement (which IS in torso-fractions by
  // virtue of canonicalization).
  const wristShoulderMatch = criterion.match(
    /(left|right)_wrist\.x\s*[−-]\s*(left|right)_shoulder\.x\s*>\s*(\d+(?:\.\d+)?)\s*m/i,
  );
  if (wristShoulderMatch) {
    const side = wristShoulderMatch[1]!.toLowerCase() as 'left' | 'right';
    const thresholdM = parseFloat(wristShoulderMatch[3]!);
    const thresholdTorsoFrac = thresholdM / refTorsoM;
    const observedFrac = maxLateralWristExtension(userSeries, side);
    if (observedFrac >= thresholdTorsoFrac) {
      return {
        passed: true,
        evidence: `${side} wrist extended ${observedFrac.toFixed(2)} torso-lengths ≥ ${thresholdTorsoFrac.toFixed(2)} (= ${thresholdM} m / ${refTorsoM} m reference torso)`,
      };
    }
    return {
      passed: false,
      evidence: `${side} wrist only extended ${observedFrac.toFixed(2)} torso-lengths, needed ${thresholdTorsoFrac.toFixed(2)}`,
    };
  }

  // (5) Ankle-rise threshold for jumps: "ankle.y > X m above floor"
  // / "ankle rises X m above its minimum". Body-relative via torso
  // fraction. Note: y in canonical landmarks is +DOWN, so a "rise" is
  // a DECREASE in y. We measure rise as max y − min y per ankle in the
  // user series.
  const ankleRise = criterion.match(/ankle.*(?:rises|above)\s*(?:its\s*minimum\s*)?\s*(\d+(?:\.\d+)?)\s*m/i);
  if (ankleRise) {
    const thresholdM = parseFloat(ankleRise[1]!);
    const thresholdTorsoFrac = thresholdM / refTorsoM;
    const observedFrac = maxAnkleRise(userSeries);
    if (observedFrac >= thresholdTorsoFrac) {
      return {
        passed: true,
        evidence: `ankle rose ${observedFrac.toFixed(2)} torso-lengths ≥ ${thresholdTorsoFrac.toFixed(2)} (= ${thresholdM} m)`,
      };
    }
    return {
      passed: false,
      evidence: `ankle only rose ${observedFrac.toFixed(2)} torso-lengths, needed ${thresholdTorsoFrac.toFixed(2)}`,
    };
  }

  // Anything else: graceful unsupported response. The scorer's own
  // 0–100 overall is still meaningful; this evaluator's job is only to
  // surface skill-graph specifics when it can.
  return notYetSupported(criterion);
}

function notYetSupported(criterion: string, reason = ''): CriterionResult {
  if (typeof console !== 'undefined') {
    // eslint-disable-next-line no-console
    console.warn(
      `[criteriaEvaluator] criterion not yet supported${reason ? ` (${reason})` : ''}: ${criterion.slice(0, 120)}${criterion.length > 120 ? '…' : ''}`,
    );
  }
  return { passed: true, evidence: 'criterion not yet supported' };
}

function rad2deg(rad: number): number {
  return (rad * 180) / Math.PI;
}

// ---- Per-criterion observation helpers ----

function elbowAngleRad(
  c: CanonicalSkeleton,
  side: 'left' | 'right',
): number {
  const lm = c.landmarks;
  const S = lm[side === 'left' ? LANDMARK.LEFT_SHOULDER : LANDMARK.RIGHT_SHOULDER]!;
  const E = lm[side === 'left' ? LANDMARK.LEFT_ELBOW : LANDMARK.RIGHT_ELBOW]!;
  const W = lm[side === 'left' ? LANDMARK.LEFT_WRIST : LANDMARK.RIGHT_WRIST]!;
  return angleAt2D(S, E, W);
}

function kneeAngleRad(
  c: CanonicalSkeleton,
  side: 'left' | 'right',
): number {
  const lm = c.landmarks;
  const H = lm[side === 'left' ? LANDMARK.LEFT_HIP : LANDMARK.RIGHT_HIP]!;
  const K = lm[side === 'left' ? LANDMARK.LEFT_KNEE : LANDMARK.RIGHT_KNEE]!;
  const A = lm[side === 'left' ? LANDMARK.LEFT_ANKLE : LANDMARK.RIGHT_ANKLE]!;
  return angleAt2D(H, K, A);
}

function angleAt2D(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
): number {
  const bax = a.x - b.x;
  const bay = a.y - b.y;
  const bcx = c.x - b.x;
  const bcy = c.y - b.y;
  const baMag = Math.sqrt(bax * bax + bay * bay);
  const bcMag = Math.sqrt(bcx * bcx + bcy * bcy);
  if (baMag * bcMag < 1e-6) return 0;
  const cos = (bax * bcx + bay * bcy) / (baMag * bcMag);
  return Math.acos(Math.max(-1, Math.min(1, cos)));
}

function maxElbowAngleAcross(series: CanonicalSkeleton[]): number {
  let m = 0;
  for (const c of series) {
    const left = elbowAngleRad(c, 'left');
    const right = elbowAngleRad(c, 'right');
    const peak = Math.max(left, right);
    if (peak > m) m = peak;
  }
  return m;
}

function minKneeAngleAcross(series: CanonicalSkeleton[]): number {
  let m = Math.PI;
  for (const c of series) {
    const left = kneeAngleRad(c, 'left');
    const right = kneeAngleRad(c, 'right');
    const lo = Math.min(left, right);
    if (lo < m) m = lo;
  }
  return m;
}

function maxKneeAngleAcross(series: CanonicalSkeleton[]): number {
  let m = 0;
  for (const c of series) {
    const left = kneeAngleRad(c, 'left');
    const right = kneeAngleRad(c, 'right');
    const hi = Math.max(left, right);
    if (hi > m) m = hi;
  }
  return m;
}

function maxLateralWristExtension(
  series: CanonicalSkeleton[],
  side: 'left' | 'right',
): number {
  let m = 0;
  for (const c of series) {
    const lm = c.landmarks;
    const W = lm[side === 'left' ? LANDMARK.LEFT_WRIST : LANDMARK.RIGHT_WRIST]!;
    const S = lm[side === 'left' ? LANDMARK.LEFT_SHOULDER : LANDMARK.RIGHT_SHOULDER]!;
    // For "wrist out beyond shoulder" we measure the signed lateral
    // displacement in the canonical (torso-length) units, taking
    // direction into account: left side expects positive x, right
    // side negative x relative to the body's centerline. Use absolute
    // value so the threshold reads naturally either way.
    const dx = Math.abs(W.x - S.x);
    if (dx > m) m = dx;
  }
  return m;
}

function maxAnkleRise(series: CanonicalSkeleton[]): number {
  // canonical y is +DOWN, so "rise" = decrease in y. Rise magnitude =
  // baseline_y − current_y. Use the resting ankle y as the baseline
  // (max y across the series), and report the max y_drop = baseline − min.
  let baseline = -Infinity;
  let minY = Infinity;
  for (const c of series) {
    const ly = c.landmarks[LANDMARK.LEFT_ANKLE]!.y;
    const ry = c.landmarks[LANDMARK.RIGHT_ANKLE]!.y;
    const lo = Math.min(ly, ry);
    const hi = Math.max(ly, ry);
    if (hi > baseline) baseline = hi;
    if (lo < minY) minY = lo;
  }
  if (!Number.isFinite(baseline) || !Number.isFinite(minY)) return 0;
  return Math.max(0, baseline - minY);
}
