// Acceptance test for spec.md round-5 — runs the new FramingGate
// against the hearts2miraaa video's pose data (the worker's BoT-SORT
// output, which mirrors what MediaPipe would emit live for a real
// dancer in front of the camera). Verifies:
//
//   1. With the auto-selected dancer in frame the whole clip, the
//      gate reaches phase='fired' after the spec-defined timing
//      (1.5 s arming + 5 × 800 ms counting + 800 ms GO step).
//   2. Tick playback fires in 5,4,3,2,1,go order, exactly once each.
//   3. When framing is broken for ≥500 ms mid-count the gate resets
//      to 'searching' and the next re-frame restarts the count from 5.
//
// Run: `npx tsx scripts/verify_framing_hearts2miraaa.ts`.
// Exits non-zero if any assertion fails.

import fs from 'node:fs';
import path from 'node:path';
import {
  COUNT_INTERVAL_MS,
  COUNT_START,
  FRAMING_HOLD_MS,
  FramingGate,
  OUT_OF_FRAME_GRACE_MS,
  isUpperBodyFramed,
} from '../lib/pose/framingCheck';
import type { PoseLandmark } from '../lib/pose/types';

interface RawFrame {
  t_ms: number;
  landmarks:
    | { x: number; y: number; z: number; visibility?: number }[]
    | null;
}

const POSE_PATH = process.argv[2] ?? '/tmp/pose_hearts2miraaa.json';
if (!fs.existsSync(POSE_PATH)) {
  console.error(`pose JSON not found at ${POSE_PATH}`);
  console.error('regenerate with: cd worker && python -c "from pose import extract_pose; from pathlib import Path; extract_pose(Path(\\"/tmp/hearts2miraaa.mp4\\"), Path(\\"/tmp/pose_hearts2miraaa.json\\"))"');
  process.exit(2);
}
const doc = JSON.parse(fs.readFileSync(POSE_PATH, 'utf-8')) as {
  frames: RawFrame[];
  auto_selected_person_id?: string;
  persons?: Array<{ id: string; frames: RawFrame[] }>;
};

// The top-level `frames` is the auto-selected dancer's track per the
// worker's pose JSON schema.
const frames = doc.frames;
const total = frames.length;
const detectedFrames = frames.filter((f) => f.landmarks !== null).length;
console.log(
  `loaded ${total} frames (${detectedFrames} with landmarks) — auto person=${doc.auto_selected_person_id}`,
);

function toLandmarks(raw: RawFrame['landmarks']): PoseLandmark[] | null {
  if (!raw) return null;
  return raw.map((p) => ({
    x: p.x,
    y: p.y,
    z: p.z,
    visibility: p.visibility ?? 1,
  }));
}

interface Run {
  fires: boolean;
  ticks: Array<{ tMs: number; k: number | 'go' }>;
  framedRatio: number;
  firstFramedAtMs: number | null;
  firstCountAtMs: number | null;
  fireAtMs: number | null;
  resetCount: number;
}

function runGate(
  framedOverride?: (i: number, base: boolean) => boolean,
): Run {
  const gate = new FramingGate();
  let prevPhase = gate.getPhase();
  const ticks: Run['ticks'] = [];
  let firstFramedAt: number | null = null;
  let firstCountAt: number | null = null;
  let fireAt: number | null = null;
  let resetCount = 0;
  let framedTrue = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    const base = isUpperBodyFramed(toLandmarks(f.landmarks));
    const framed = framedOverride ? framedOverride(i, base) : base;
    if (framed) framedTrue++;
    if (framed && firstFramedAt === null) firstFramedAt = f.t_ms;
    const r = gate.tick(framed, f.t_ms);
    if (
      prevPhase === 'counting' &&
      r.phase === 'searching'
    ) resetCount++;
    if (r.phase === 'counting' && firstCountAt === null) firstCountAt = f.t_ms;
    if (r.tickFired !== undefined) ticks.push({ tMs: f.t_ms, k: r.tickFired });
    if (r.fired && fireAt === null) fireAt = f.t_ms;
    prevPhase = r.phase;
  }
  return {
    fires: fireAt !== null,
    ticks,
    framedRatio: framedTrue / Math.max(1, frames.length),
    firstFramedAtMs: firstFramedAt,
    firstCountAtMs: firstCountAt,
    fireAtMs: fireAt,
    resetCount,
  };
}

let failed = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`, detail ?? '');
    failed++;
  }
}

console.log('\n--- Test 1: continuous in-frame ---');
const r1 = runGate();
console.log(
  `  framedRatio=${(r1.framedRatio * 100).toFixed(0)}%  firstFramedAt=${r1.firstFramedAtMs}  firstCountAt=${r1.firstCountAtMs}  fireAt=${r1.fireAtMs}`,
);
console.log('  ticks:', r1.ticks);
check('gate reaches fired', r1.fires);
check('reasonable framedRatio (>50%) — auto dancer is mostly upper-body-visible', r1.framedRatio > 0.5, r1.framedRatio);
check(
  'first count step is at least 1500ms after first framed frame (arming hold respected)',
  r1.firstFramedAtMs !== null &&
    r1.firstCountAtMs !== null &&
    r1.firstCountAtMs - r1.firstFramedAtMs >= FRAMING_HOLD_MS - 50,
  { delta: r1.firstFramedAtMs !== null && r1.firstCountAtMs !== null ? r1.firstCountAtMs - r1.firstFramedAtMs : null },
);
check(
  'tick sequence is exactly 5,4,3,2,1,go',
  JSON.stringify(r1.ticks.map((t) => t.k)) === JSON.stringify([5, 4, 3, 2, 1, 'go']),
  r1.ticks.map((t) => t.k),
);
check(
  'fire timestamp is ~5 × 800ms past first count (the GO step)',
  r1.fireAtMs !== null &&
    r1.firstCountAtMs !== null &&
    Math.abs(r1.fireAtMs - r1.firstCountAtMs - 5 * COUNT_INTERVAL_MS) <= 50,
  { fireAtMs: r1.fireAtMs, firstCountAtMs: r1.firstCountAtMs },
);
check('no reset events on the happy path', r1.resetCount === 0, { resetCount: r1.resetCount });

// Test 2: force a step-out window mid-countdown and verify the gate
// resets, then the user re-entering causes a fresh restart from 5.
//
// We pick a step-out window that starts ~1 step into the countdown
// and lasts well past OUT_OF_FRAME_GRACE_MS. Translation:
//   stepOutStart = firstCountAt + ~400ms  (mid-step)
//   stepOutEnd   = stepOutStart + 1000ms  (well past 500ms grace)
console.log('\n--- Test 2: step-out for 1s mid-countdown ---');
const stepOutStartMs = (r1.firstCountAtMs ?? 0) + Math.floor(COUNT_INTERVAL_MS * 0.5);
const stepOutEndMs = stepOutStartMs + 1000;
const r2 = runGate((_, base) => {
  // Look at the current frame's timestamp via closure — we use the
  // existing iteration which provides `i`; resolve to t_ms.
  return base;
});

// We need access to the frame timestamp inside the override closure;
// rewrite using runGate's framedOverride which takes (i, base). The
// `i` indexes into `frames`, so we can map to t_ms there.
const r2real = runGate((i, base) => {
  const tMs = frames[i]!.t_ms;
  if (tMs >= stepOutStartMs && tMs < stepOutEndMs) return false;
  return base;
});
console.log(
  `  stepOutWindow=[${stepOutStartMs}, ${stepOutEndMs})ms  resetCount=${r2real.resetCount}  fireAt=${r2real.fireAtMs}`,
);
console.log('  ticks:', r2real.ticks);
check('at least one reset occurred (counting → searching)', r2real.resetCount >= 1, { resetCount: r2real.resetCount });
check(
  'gate still ultimately fires (the user re-enters frame and re-arms)',
  r2real.fires,
);
check(
  'first six ticks include a SECOND 5, proving the count restarted from 5',
  r2real.ticks.filter((t) => t.k === 5).length >= 2,
  r2real.ticks.map((t) => t.k),
);
// Fire must be strictly later than the happy-path fire, since the
// step-out forces a fresh arm + count cycle. The exact delay depends
// on framing flicker after the step-out window, so we just assert
// "strictly later by at least one full count cycle".
check(
  `fire is delayed by at least one full count cycle — got ${(r2real.fireAtMs ?? 0) - (r1.fireAtMs ?? 0)}ms`,
  (r2real.fireAtMs ?? 0) > (r1.fireAtMs ?? 0) + 5 * COUNT_INTERVAL_MS - 100,
);

console.log('');
if (failed) {
  console.error(`FAILED: ${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('ALL ACCEPTANCE CHECKS PASSED');
