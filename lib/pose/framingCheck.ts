// Hands-free framing gate (spec.md round-5).
//
// Pure TS, no DOM, no React. The onboarding screen feeds per-frame
// landmarks into `isUpperBodyFramed`, then ticks a `FramingGate`
// instance with the resulting boolean + a monotonic clock. The gate
// runs this state machine:
//
//   searching → arming → counting → fired
//
// Transitions:
//   searching → arming    when framed=true
//   arming    → searching when framed=false
//   arming    → counting  after FRAMING_HOLD_MS (1.5 s) framed
//   counting  → searching when framed=false for ≥ OUT_OF_FRAME_GRACE_MS (0.5 s)
//   counting  → fired     after 5 × COUNT_INTERVAL_MS (5 × 800 ms = 4 s)
//
// The reset rule covers the spec line: "If during the countdown the
// user steps out of frame (framing condition breaks for >0.5s), pause
// the countdown and revert to the silhouette guide — when they step
// back in, the countdown restarts from 5." We treat "revert" as a full
// reset; the arming hold then re-arms before counting restarts at 5.

import { LANDMARK, type PoseLandmark } from './types';

// MediaPipe (33-landmark) indices that must be detected with
// confidence ≥ CONFIDENCE_FLOOR and inside SILHOUETTE_BOUNDS. The spec
// lists COCO 0..14 (nose, eyes, ears, shoulders, elbows, wrists, hips,
// knees) — translated to MediaPipe indices below. Ankles + feet
// (COCO 15, 16 / MP 27..32) are intentionally NOT in this list.
export const REQUIRED_LANDMARKS: readonly number[] = [
  LANDMARK.NOSE,
  LANDMARK.LEFT_EYE,
  LANDMARK.RIGHT_EYE,
  LANDMARK.LEFT_EAR,
  LANDMARK.RIGHT_EAR,
  LANDMARK.LEFT_SHOULDER,
  LANDMARK.RIGHT_SHOULDER,
  LANDMARK.LEFT_ELBOW,
  LANDMARK.RIGHT_ELBOW,
  LANDMARK.LEFT_WRIST,
  LANDMARK.RIGHT_WRIST,
  LANDMARK.LEFT_HIP,
  LANDMARK.RIGHT_HIP,
  LANDMARK.LEFT_KNEE,
  LANDMARK.RIGHT_KNEE,
];

// Camera-space bounds (normalised 0..1) the required joints must
// live inside. Loose by design — the spec's whole point is to let
// users stand closer to the phone, so we don't penalise framings
// where ankles run off the bottom of the frame and knees end up
// near y≈0.95. The horizontal margins match the silhouette graphic;
// y1 is intentionally just below 1.0 so knees-near-bottom passes.
export const SILHOUETTE_BOUNDS = {
  x0: 0.12,
  x1: 0.88,
  y0: 0.05,
  y1: 0.97,
} as const;

export const CONFIDENCE_FLOOR = 0.5;

export function isUpperBodyFramed(
  landmarks: PoseLandmark[] | null | undefined,
): boolean {
  if (!landmarks) return false;
  for (const idx of REQUIRED_LANDMARKS) {
    const lm = landmarks[idx];
    if (!lm) return false;
    if ((lm.visibility ?? 0) < CONFIDENCE_FLOOR) return false;
    if (lm.x < SILHOUETTE_BOUNDS.x0 || lm.x > SILHOUETTE_BOUNDS.x1) return false;
    if (lm.y < SILHOUETTE_BOUNDS.y0 || lm.y > SILHOUETTE_BOUNDS.y1) return false;
  }
  return true;
}

// ---- gate state machine -------------------------------------------

export const FRAMING_HOLD_MS = 1500;
export const OUT_OF_FRAME_GRACE_MS = 500;
export const COUNT_INTERVAL_MS = 800;
export const COUNT_START = 5;

export type FramingPhase = 'searching' | 'arming' | 'counting' | 'fired';

export interface FramingTickResult {
  phase: FramingPhase;
  // Big number to render. 5..1 during counting, 0 during 'fired'
  // (render as "GO"), COUNT_START in all other phases.
  count: number;
  // Number (or 'go') the page should play playTick() for in this step.
  // Undefined when no tick should fire.
  tickFired?: number | 'go';
  // True exactly once, on the step that transitions into 'fired'.
  fired?: boolean;
}

export class FramingGate {
  private phase: FramingPhase = 'searching';
  private framedSinceMs: number | null = null;
  private unframedSinceMs: number | null = null;
  private countdownStartedAtMs: number | null = null;
  // Tracks the last "count number" we emitted a tick for, so the same
  // tick doesn't double-fire across multiple animation frames.
  private lastCountFired = COUNT_START + 1;

  tick(framed: boolean, nowMs: number): FramingTickResult {
    switch (this.phase) {
      case 'searching':
        if (framed) {
          this.framedSinceMs = nowMs;
          this.phase = 'arming';
        }
        return { phase: this.phase, count: COUNT_START };

      case 'arming':
        if (!framed) {
          this.framedSinceMs = null;
          this.phase = 'searching';
          return { phase: 'searching', count: COUNT_START };
        }
        if (nowMs - (this.framedSinceMs ?? nowMs) >= FRAMING_HOLD_MS) {
          this.phase = 'counting';
          this.countdownStartedAtMs = nowMs;
          this.lastCountFired = COUNT_START;
          return {
            phase: 'counting',
            count: COUNT_START,
            tickFired: COUNT_START,
          };
        }
        return { phase: 'arming', count: COUNT_START };

      case 'counting': {
        // Sub-grace out-of-frame: keep counting; the user might just
        // have raised an arm past the silhouette edge for a frame or
        // two. Past grace: full reset.
        if (!framed) {
          if (this.unframedSinceMs === null) this.unframedSinceMs = nowMs;
          if (nowMs - this.unframedSinceMs >= OUT_OF_FRAME_GRACE_MS) {
            this.reset();
            return { phase: 'searching', count: COUNT_START };
          }
        } else {
          this.unframedSinceMs = null;
        }
        const elapsed = nowMs - (this.countdownStartedAtMs ?? nowMs);
        const stepsCompleted = Math.floor(elapsed / COUNT_INTERVAL_MS);
        const currentCount = COUNT_START - stepsCompleted;

        let tickFired: number | 'go' | undefined;
        if (currentCount < this.lastCountFired) {
          this.lastCountFired = currentCount;
          tickFired = currentCount > 0 ? currentCount : 'go';
        }

        if (currentCount <= 0) {
          this.phase = 'fired';
          return { phase: 'fired', count: 0, tickFired, fired: true };
        }
        return { phase: 'counting', count: currentCount, tickFired };
      }

      case 'fired':
        return { phase: 'fired', count: 0 };
    }
  }

  reset(): void {
    this.phase = 'searching';
    this.framedSinceMs = null;
    this.unframedSinceMs = null;
    this.countdownStartedAtMs = null;
    this.lastCountFired = COUNT_START + 1;
  }

  getPhase(): FramingPhase {
    return this.phase;
  }
}
