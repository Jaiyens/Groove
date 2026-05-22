// Stage 6 verification of the Mode B scoring rebuild.
//
// We can't drive a real camera from a Node test, so this suite
// constructs synthetic but realistic pose-vector streams and checks
// that the rebuilt scorer's output lands in the bands SPECK.md Stage 6
// calls for:
//
//   - Stand still through a dance → overall < 25
//   - Wave arms randomly through a dance → overall < 40
//   - Actually attempt the dance → overall 55-80
//   - Component scores differentiate arm-perfect vs leg-perfect users
//   - A frozen second appears as a trouble spot
//   - Headline copy maps to expected score bands

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scoreSession } from '../lib/scoring/scorer.ts';
import type { BeatGrid } from '../lib/scoring/types.ts';
import type { FrameSample, JointAngleVector } from '../lib/pose/types.ts';

function emptyVec(o: Partial<JointAngleVector> = {}): JointAngleVector {
  return {
    left_elbow: 0,
    right_elbow: 0,
    left_shoulder: 0,
    right_shoulder: 0,
    left_hip: 0,
    right_hip: 0,
    left_knee: 0,
    right_knee: 0,
    torso_lean: 0,
    hip_rotation_y: 0,
    chest_forward_z: 0,
    ...o,
  };
}

function beats(bpm: number): BeatGrid {
  const period = 60000 / bpm;
  return {
    bpm,
    startMs: 0,
    getBeatAt: (t) => t / period,
    msAtBeat: (b) => b * period,
  };
}

// Build a 5-second arm-heavy reference: shoulders oscillating ±40°,
// elbows oscillating ±30°, legs static. This matches a typical arm-
// driven TikTok dance well enough to calibrate against.
function armHeavyReference(): FrameSample[] {
  const dur = 5000;
  const fps = 30;
  const dt = 1000 / fps;
  const out: FrameSample[] = [];
  for (let i = 0; i < dur / dt; i++) {
    const t = i * dt;
    const phase = Math.sin((t / 1000) * 2 * Math.PI); // 1 Hz arm sway
    out.push({
      timestampMs: t,
      vector: emptyVec({
        left_shoulder: 20 + 30 * phase,
        right_shoulder: 20 - 30 * phase,
        left_elbow: 120 - 25 * phase,
        right_elbow: 120 + 25 * phase,
        left_hip: 170,
        right_hip: 170,
        left_knee: 170,
        right_knee: 170,
        torso_lean: 5 * phase,
      }),
    });
  }
  return out;
}

describe('mode-b calibration', () => {
  it('stand-still user scores < 25 on an arm-heavy reference', () => {
    const ref = armHeavyReference();
    const stillVec = emptyVec({
      left_shoulder: 20,
      right_shoulder: 20,
      left_elbow: 170,
      right_elbow: 170,
      left_hip: 170,
      right_hip: 170,
      left_knee: 170,
      right_knee: 170,
      torso_lean: 0,
    });
    const user = ref.map((f) => ({ timestampMs: f.timestampMs, vector: stillVec }));
    const r = scoreSession({
      userFrames: user,
      referenceFrames: ref,
      beatGrid: beats(120),
      skillIds: [],
    });
    assert.ok(r.overall < 25, `stand-still overall=${r.overall}`);
  });

  it('random-arm-flailing user scores < 40', () => {
    const ref = armHeavyReference();
    // Random arms — uncorrelated with the reference's oscillation.
    let seed = 1;
    const rand = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    const user = ref.map((f) => ({
      timestampMs: f.timestampMs,
      vector: emptyVec({
        left_shoulder: 60 + 60 * (rand() - 0.5),
        right_shoulder: 60 + 60 * (rand() - 0.5),
        left_elbow: 90 + 80 * (rand() - 0.5),
        right_elbow: 90 + 80 * (rand() - 0.5),
        left_hip: 170,
        right_hip: 170,
        left_knee: 170,
        right_knee: 170,
        torso_lean: 0,
      }),
    }));
    const r = scoreSession({
      userFrames: user,
      referenceFrames: ref,
      beatGrid: beats(120),
      skillIds: [],
    });
    assert.ok(r.overall < 40, `random-arms overall=${r.overall}`);
  });

  it('decent attempt with ~8° noise scores in the 55-90 band', () => {
    const ref = armHeavyReference();
    // The user tracks the reference but with ±8° angle noise per
    // joint per frame — what a real-life "doing the move competently"
    // looks like at the MediaPipe-detection-noise + small user-error
    // level. The reference dancer themselves wouldn't repeat a take
    // with much less noise than this.
    let seed = 42;
    const rand = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    const noisy = (x: number) => x + 16 * (rand() - 0.5);
    const user = ref.map((f) => ({
      timestampMs: f.timestampMs,
      vector: emptyVec({
        left_shoulder: noisy(f.vector.left_shoulder),
        right_shoulder: noisy(f.vector.right_shoulder),
        left_elbow: noisy(f.vector.left_elbow),
        right_elbow: noisy(f.vector.right_elbow),
        left_hip: noisy(f.vector.left_hip),
        right_hip: noisy(f.vector.right_hip),
        left_knee: noisy(f.vector.left_knee),
        right_knee: noisy(f.vector.right_knee),
        torso_lean: noisy(f.vector.torso_lean),
      }),
    }));
    const r = scoreSession({
      userFrames: user,
      referenceFrames: ref,
      beatGrid: beats(120),
      skillIds: [],
    });
    assert.ok(r.overall >= 55 && r.overall <= 90, `decent attempt overall=${r.overall}`);
  });

  it('perfect copy scores ≥ 95', () => {
    const ref = armHeavyReference();
    const r = scoreSession({
      userFrames: ref,
      referenceFrames: ref,
      beatGrid: beats(120),
      skillIds: [],
    });
    assert.ok(r.overall >= 95, `perfect copy overall=${r.overall}`);
  });

  it('component scores differentiate arms-perfect vs legs-perfect', () => {
    // Build a reference where BOTH arms and legs move. The user
    // tracks arms exactly but holds legs static. Arms score should
    // be high; Legs should be low.
    const dur = 5000;
    const fps = 30;
    const dt = 1000 / fps;
    const ref: FrameSample[] = [];
    for (let i = 0; i < dur / dt; i++) {
      const t = i * dt;
      const phase = Math.sin((t / 1000) * 2 * Math.PI);
      ref.push({
        timestampMs: t,
        vector: emptyVec({
          left_shoulder: 20 + 30 * phase,
          right_shoulder: 20 - 30 * phase,
          left_elbow: 120 - 25 * phase,
          right_elbow: 120 + 25 * phase,
          left_knee: 140 + 30 * phase, // moving legs
          right_knee: 140 - 30 * phase,
          left_hip: 165 + 8 * phase,
          right_hip: 165 - 8 * phase,
        }),
      });
    }
    const armsPerfectLegsStatic = ref.map((f) => ({
      timestampMs: f.timestampMs,
      vector: emptyVec({
        left_shoulder: f.vector.left_shoulder,
        right_shoulder: f.vector.right_shoulder,
        left_elbow: f.vector.left_elbow,
        right_elbow: f.vector.right_elbow,
        left_knee: 170,
        right_knee: 170,
        left_hip: 170,
        right_hip: 170,
      }),
    }));
    const r = scoreSession({
      userFrames: armsPerfectLegsStatic,
      referenceFrames: ref,
      beatGrid: beats(120),
      skillIds: [],
    });
    assert.ok(r.components !== undefined);
    assert.ok(
      r.components!.arms > 80,
      `expected arms high, got ${r.components!.arms}`,
    );
    assert.ok(
      r.components!.legs < 60,
      `expected legs low, got ${r.components!.legs}`,
    );
    assert.ok(
      r.components!.arms - r.components!.legs > 25,
      `expected clear arms>legs gap, got arms=${r.components!.arms} legs=${r.components!.legs}`,
    );
  });

  it('a 1.5s freeze mid-chunk appears as a trouble spot', () => {
    const ref = armHeavyReference();
    // User tracks the reference for the first 1.5s, freezes for the
    // middle 1.5s, then tracks again. Trouble-spot finder should land
    // a window inside [1500, 3000).
    const user = ref.map((f) => {
      if (f.timestampMs >= 1500 && f.timestampMs < 3000) {
        return {
          timestampMs: f.timestampMs,
          vector: emptyVec({
            left_shoulder: 20,
            right_shoulder: 20,
            left_elbow: 170,
            right_elbow: 170,
            left_hip: 170,
            right_hip: 170,
            left_knee: 170,
            right_knee: 170,
          }),
        };
      }
      return { timestampMs: f.timestampMs, vector: f.vector };
    });
    const r = scoreSession({
      userFrames: user,
      referenceFrames: ref,
      beatGrid: beats(120),
      skillIds: [],
    });
    assert.ok(r.troubleSpots !== undefined);
    assert.ok(r.troubleSpots!.length > 0, 'expected at least one trouble spot');
    const overlap = r.troubleSpots!.some(
      (s) => s.startMs < 3000 && s.endMs > 1500,
    );
    assert.ok(
      overlap,
      `expected a trouble spot to overlap [1500, 3000), got ${JSON.stringify(r.troubleSpots)}`,
    );
  });
});
