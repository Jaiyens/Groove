// Pure-TS joint-angle math. NO browser dependencies. This module is the
// one you port to Swift (same vector type, same formulas).
//
// Inputs are MediaPipe world landmarks: 33 entries, meters, origin at hip
// midpoint. Outputs are angles in degrees and displacements in meters.

import { LANDMARK, type JointAngleVector, type PoseLandmark } from './types';

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

function v(p: PoseLandmark | undefined): Vec3 {
  return { x: p?.x ?? 0, y: p?.y ?? 0, z: p?.z ?? 0 };
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

function midpoint(a: Vec3, b: Vec3): Vec3 {
  return scale(add(a, b), 0.5);
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function length(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}

const RAD2DEG = 180 / Math.PI;

// Angle (in degrees) at vertex B in the triangle A-B-C.
function angleAt(a: Vec3, b: Vec3, c: Vec3): number {
  const ba = sub(a, b);
  const bc = sub(c, b);
  const denom = length(ba) * length(bc);
  if (denom < 1e-9) return 0;
  const cos = Math.max(-1, Math.min(1, dot(ba, bc) / denom));
  return Math.acos(cos) * RAD2DEG;
}

// Angle (in degrees) between a vector and the world +Y axis.
function angleFromY(v: Vec3): number {
  const denom = length(v);
  if (denom < 1e-9) return 0;
  const cos = Math.max(-1, Math.min(1, v.y / denom));
  return Math.acos(cos) * RAD2DEG;
}

// Signed angle (in degrees) of the hip line projected onto the xz-plane,
// measured from +x. 0 = hips face camera (left hip on +x). +90 = right side
// to camera. Range (-180, 180].
function hipRotationY(leftHip: Vec3, rightHip: Vec3): number {
  const d = sub(rightHip, leftHip);
  return Math.atan2(d.z, d.x) * RAD2DEG;
}

// Compute the full joint-angle vector from world landmarks.
//
// IMPORTANT: pass *world* landmarks (PoseResult.worldLandmarks), not the
// normalized image landmarks. Image landmarks include perspective distortion
// from the camera FOV and produce unreliable angles.
export function computeJointAngles(worldLandmarks: PoseLandmark[]): JointAngleVector {
  const Ls = v(worldLandmarks[LANDMARK.LEFT_SHOULDER]);
  const Rs = v(worldLandmarks[LANDMARK.RIGHT_SHOULDER]);
  const Le = v(worldLandmarks[LANDMARK.LEFT_ELBOW]);
  const Re = v(worldLandmarks[LANDMARK.RIGHT_ELBOW]);
  const Lw = v(worldLandmarks[LANDMARK.LEFT_WRIST]);
  const Rw = v(worldLandmarks[LANDMARK.RIGHT_WRIST]);
  const Lh = v(worldLandmarks[LANDMARK.LEFT_HIP]);
  const Rh = v(worldLandmarks[LANDMARK.RIGHT_HIP]);
  const Lk = v(worldLandmarks[LANDMARK.LEFT_KNEE]);
  const Rk = v(worldLandmarks[LANDMARK.RIGHT_KNEE]);
  const La = v(worldLandmarks[LANDMARK.LEFT_ANKLE]);
  const Ra = v(worldLandmarks[LANDMARK.RIGHT_ANKLE]);

  const hipMid = midpoint(Lh, Rh);
  const shoulderMid = midpoint(Ls, Rs);

  return {
    left_elbow: angleAt(Ls, Le, Lw),
    right_elbow: angleAt(Rs, Re, Rw),
    left_shoulder: angleAt(Lh, Ls, Le),
    right_shoulder: angleAt(Rh, Rs, Re),
    left_hip: angleAt(Ls, Lh, Lk),
    right_hip: angleAt(Rs, Rh, Rk),
    left_knee: angleAt(Lh, Lk, La),
    right_knee: angleAt(Rh, Rk, Ra),
    // Torso lean: angle between spine vector (hipMid -> shoulderMid) and +Y.
    // Note: MediaPipe world coordinates use +Y up only in some configurations;
    // BlazePose world landmarks use +Y DOWN. We negate to get an upright-spine
    // vector that points toward +Y for an upright person.
    torso_lean: angleFromY({
      x: shoulderMid.x - hipMid.x,
      y: -(shoulderMid.y - hipMid.y),
      z: shoulderMid.z - hipMid.z,
    }),
    hip_rotation_y: hipRotationY(Lh, Rh),
    // Chest = shoulder midpoint. Forward displacement = z component of
    // (shoulderMid - hipMid). In MediaPipe world coords, more negative z is
    // forward (toward camera).
    chest_forward_z: -(shoulderMid.z - hipMid.z),
  };
}

// Euclidean distance between two joint-angle vectors. Used as the local cost
// in DTW. Angles are in degrees; chest_forward_z is in meters — we keep them
// in their natural units since both move on roughly the same scale once the
// person is upright (small displacements vs small angle changes per beat).
export function vectorDistance(a: JointAngleVector, b: JointAngleVector): number {
  let s = 0;
  for (const key of Object.keys(a) as (keyof JointAngleVector)[]) {
    const d = (a[key] ?? 0) - (b[key] ?? 0);
    s += d * d;
  }
  return Math.sqrt(s);
}
