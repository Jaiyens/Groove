// Synthetic reference frames for the prototype.
//
// Real reference pose data (extracted via MediaPipe on the reference video,
// or precomputed and shipped as a sidecar) arrives tomorrow. Until then, this
// produces a slowly-oscillating "neutral with subtle motion" reference so the
// live score has variance the user can react to.
//
// Replace with: precomputed JointAngleVector[] loaded from a sidecar JSON
// next to each reference video (e.g. /data/reference_dances/apt.poses.json).

import type { FrameSample, JointAngleVector } from '@/lib/pose/types';

const NEUTRAL: JointAngleVector = {
  left_elbow: 170,
  right_elbow: 170,
  left_shoulder: 20,
  right_shoulder: 20,
  left_hip: 175,
  right_hip: 175,
  left_knee: 175,
  right_knee: 175,
  torso_lean: 0,
  hip_rotation_y: 180,
  chest_forward_z: 0,
};

export function neutralReferenceFrame(timestampMs: number, bpm: number): JointAngleVector {
  // Light oscillation on the beat to make the demo feel dance-y.
  const beat = (timestampMs / 1000) * (bpm / 60);
  const phase = Math.sin(beat * Math.PI);
  const lean = phase * 4; // ±4° torso sway
  const shoulderSway = phase * 8; // ±8° shoulder bob
  return {
    ...NEUTRAL,
    torso_lean: lean,
    left_shoulder: NEUTRAL.left_shoulder + shoulderSway,
    right_shoulder: NEUTRAL.right_shoulder - shoulderSway,
  };
}

export function generateReferenceSequence(
  durationSeconds: number,
  bpm: number,
  fps = 30,
): FrameSample[] {
  const dtMs = 1000 / fps;
  const total = Math.floor(durationSeconds * fps);
  const frames: FrameSample[] = [];
  for (let i = 0; i < total; i++) {
    const t = i * dtMs;
    frames.push({ timestampMs: t, vector: neutralReferenceFrame(t, bpm) });
  }
  return frames;
}
