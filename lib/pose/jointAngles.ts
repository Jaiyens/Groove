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

// 2D variant: computes joint angles from MediaPipe normalized image
// landmarks (x,y ∈ [0,1], z ignored). Used when comparing a live user
// pose to a reference pose whose JSON has only 2D coordinates (the
// worker pipeline writes z=0 for every joint — it runs an off-the-shelf
// COCO-17 detector, not full 3D BlazePose). Returns the same
// JointAngleVector shape as computeJointAngles, with hip_rotation_y and
// chest_forward_z forced to 0 because both require depth to be
// meaningful and would contaminate a 2D-only similarity score.
//
// Caller is responsible for using this consistently on BOTH the user
// stream and the reference stream so the units line up.
export function compute2DJointAngles(landmarks: PoseLandmark[]): JointAngleVector {
  const Ls = v(landmarks[LANDMARK.LEFT_SHOULDER]);
  const Rs = v(landmarks[LANDMARK.RIGHT_SHOULDER]);
  const Le = v(landmarks[LANDMARK.LEFT_ELBOW]);
  const Re = v(landmarks[LANDMARK.RIGHT_ELBOW]);
  const Lw = v(landmarks[LANDMARK.LEFT_WRIST]);
  const Rw = v(landmarks[LANDMARK.RIGHT_WRIST]);
  const Lh = v(landmarks[LANDMARK.LEFT_HIP]);
  const Rh = v(landmarks[LANDMARK.RIGHT_HIP]);
  const Lk = v(landmarks[LANDMARK.LEFT_KNEE]);
  const Rk = v(landmarks[LANDMARK.RIGHT_KNEE]);
  const La = v(landmarks[LANDMARK.LEFT_ANKLE]);
  const Ra = v(landmarks[LANDMARK.RIGHT_ANKLE]);

  // Force z to 0 so 2D math is unambiguous regardless of whether the
  // input has populated z values or not.
  const flat = (p: Vec3): Vec3 => ({ x: p.x, y: p.y, z: 0 });

  const fLs = flat(Ls);
  const fRs = flat(Rs);
  const fLe = flat(Le);
  const fRe = flat(Re);
  const fLw = flat(Lw);
  const fRw = flat(Rw);
  const fLh = flat(Lh);
  const fRh = flat(Rh);
  const fLk = flat(Lk);
  const fRk = flat(Rk);
  const fLa = flat(La);
  const fRa = flat(Ra);

  const hipMid = midpoint(fLh, fRh);
  const shoulderMid = midpoint(fLs, fRs);

  return {
    left_elbow: angleAt(fLs, fLe, fLw),
    right_elbow: angleAt(fRs, fRe, fRw),
    left_shoulder: angleAt(fLh, fLs, fLe),
    right_shoulder: angleAt(fRh, fRs, fRe),
    left_hip: angleAt(fLs, fLh, fLk),
    right_hip: angleAt(fRs, fRh, fRk),
    left_knee: angleAt(fLh, fLk, fLa),
    right_knee: angleAt(fRh, fRk, fRa),
    // Image y is +DOWN — spine vector "up" is -y. Negate the y
    // component before measuring angle from +Y.
    torso_lean: angleFromY({
      x: shoulderMid.x - hipMid.x,
      y: -(shoulderMid.y - hipMid.y),
      z: 0,
    }),
    // Depth-dependent fields zeroed for 2D consistency.
    hip_rotation_y: 0,
    chest_forward_z: 0,
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
