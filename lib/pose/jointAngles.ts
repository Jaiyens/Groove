// Pure-TS joint-angle math. NO browser dependencies. This module is the
// one you port to Swift (same vector type, same formulas).
//
// Inputs are MediaPipe world landmarks: 33 entries, meters, origin at hip
// midpoint. Outputs are angles in degrees and displacements in meters.

import type { CanonicalSkeleton } from './canonicalize';
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

// -----------------------------------------------------------------------
// Canonical-space joint-angle vector (Stage 3 of the SPECK rebuild).
//
// Lives in PARALLEL to the legacy JointAngleVector above: the legacy
// vector is in degrees on raw-landmark inputs and the existing scorer +
// tests keep using it during the staged migration. This new shape is in
// radians, computed on already-canonicalized landmarks (pelvis at
// origin, torso length 1), and is the comparison primitive that Stage 4
// rewires the scorer onto.
//
// Why a new struct instead of extending the old one:
//   - Different units (radians vs degrees) so we don't silently mix
//     them in shared math.
//   - Different joint coverage (adds shoulderTilt, hipTilt; drops
//     hip_rotation_y, chest_forward_z which require depth).
//   - Carries per-joint confidence = min visibility of landmarks used
//     in that angle, so the scorer can drop low-confidence joint
//     contributions per-frame without throwing the whole frame away.
//   - Keeps the snake_case/camelCase split honest about which side of
//     the migration each consumer is on.
// -----------------------------------------------------------------------

export type CanonicalJointName =
  | 'leftElbow'
  | 'rightElbow'
  | 'leftShoulder'
  | 'rightShoulder'
  | 'leftHip'
  | 'rightHip'
  | 'leftKnee'
  | 'rightKnee'
  | 'torsoLean'
  | 'shoulderTilt'
  | 'hipTilt';

export const CANONICAL_JOINT_NAMES: readonly CanonicalJointName[] = [
  'leftElbow',
  'rightElbow',
  'leftShoulder',
  'rightShoulder',
  'leftHip',
  'rightHip',
  'leftKnee',
  'rightKnee',
  'torsoLean',
  'shoulderTilt',
  'hipTilt',
] as const;

export interface CanonicalJointAngles {
  // All angles in radians, all in [0, π]. Joints follow the convention
  // angleAt(A, B, C) — angle at vertex B in the triangle A-B-C.
  leftElbow: number;   // angle at LE, vectors LE→LS and LE→LW
  rightElbow: number;  // angle at RE, vectors RE→RS and RE→RW
  leftShoulder: number;  // angle at LS, vectors LS→LH and LS→LE
  rightShoulder: number; // angle at RS, vectors RS→RH and RS→RE
  leftHip: number;       // angle at LH, vectors LH→LS and LH→LK
  rightHip: number;      // angle at RH, vectors RH→RS and RH→RK
  leftKnee: number;      // angle at LK, vectors LK→LH and LK→LA
  rightKnee: number;     // angle at RK, vectors RK→RH and RK→RA
  // torsoLean: angle between world-up (0, -1) in image-space and the
  // pelvis→shoulderMid vector. Canonical-space pelvis is (0,0) so this
  // collapses to angle(shoulderMid, (0,-1)).
  torsoLean: number;
  // shoulderTilt: angle between horizontal (1, 0) and the
  // (leftShoulder → rightShoulder) vector. Range [0, π].
  shoulderTilt: number;
  // hipTilt: angle between horizontal (1, 0) and the
  // (leftHip → rightHip) vector. Range [0, π].
  hipTilt: number;
  // Per-joint confidence. Each value is min(visibility of the
  // landmarks involved in that joint's computation), in [0,1]. The
  // scorer reads this to fade out low-confidence joints per-frame.
  // Keyed by the same names as the angle fields above.
  confidence: Record<CanonicalJointName, number>;
}

// Angle between two 2D vectors a and b. Returns radians in [0, π].
// Coordinate-system note: we only use x and y components of canonical
// landmarks here. Canonical z is preserved for 3D consumers but the
// angles defined above are 2D (image-plane) by design — they match the
// 2D nature of the reference pose JSON (z = 0 for every frame).
function angle2DAt(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }): number {
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

function angle2DBetween(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const aMag = Math.sqrt(a.x * a.x + a.y * a.y);
  const bMag = Math.sqrt(b.x * b.x + b.y * b.y);
  if (aMag * bMag < 1e-6) return 0;
  const cos = (a.x * b.x + a.y * b.y) / (aMag * bMag);
  return Math.acos(Math.max(-1, Math.min(1, cos)));
}

function minVis(...vs: number[]): number {
  let m = 1;
  for (const v of vs) if (v < m) m = v;
  return Math.max(0, m);
}

export function jointAnglesFromCanonical(c: CanonicalSkeleton): CanonicalJointAngles {
  const lm = c.landmarks;
  const Ls = lm[LANDMARK.LEFT_SHOULDER]!;
  const Rs = lm[LANDMARK.RIGHT_SHOULDER]!;
  const Le = lm[LANDMARK.LEFT_ELBOW]!;
  const Re = lm[LANDMARK.RIGHT_ELBOW]!;
  const Lw = lm[LANDMARK.LEFT_WRIST]!;
  const Rw = lm[LANDMARK.RIGHT_WRIST]!;
  const Lh = lm[LANDMARK.LEFT_HIP]!;
  const Rh = lm[LANDMARK.RIGHT_HIP]!;
  const Lk = lm[LANDMARK.LEFT_KNEE]!;
  const Rk = lm[LANDMARK.RIGHT_KNEE]!;
  const La = lm[LANDMARK.LEFT_ANKLE]!;
  const Ra = lm[LANDMARK.RIGHT_ANKLE]!;

  // shoulderMid in canonical space — pelvis is at origin so this is
  // also the spine vector from pelvis up to shoulder mid.
  const shoulderMid = { x: (Ls.x + Rs.x) / 2, y: (Ls.y + Rs.y) / 2 };
  // World "up" reference for torsoLean. Canonical landmarks inherit
  // their y-axis orientation from the raw inputs. MediaPipe normalized
  // image landmarks use +y down; world landmarks use +y down as well
  // (BlazePose world convention). Either way, "up" is -y.
  const UP_2D = { x: 0, y: -1 };
  // Horizontal reference for shoulderTilt and hipTilt.
  const RIGHT_2D = { x: 1, y: 0 };

  const confidence: Record<CanonicalJointName, number> = {
    leftElbow: minVis(Ls.visibility, Le.visibility, Lw.visibility),
    rightElbow: minVis(Rs.visibility, Re.visibility, Rw.visibility),
    leftShoulder: minVis(Lh.visibility, Ls.visibility, Le.visibility),
    rightShoulder: minVis(Rh.visibility, Rs.visibility, Re.visibility),
    leftHip: minVis(Ls.visibility, Lh.visibility, Lk.visibility),
    rightHip: minVis(Rs.visibility, Rh.visibility, Rk.visibility),
    leftKnee: minVis(Lh.visibility, Lk.visibility, La.visibility),
    rightKnee: minVis(Rh.visibility, Rk.visibility, Ra.visibility),
    torsoLean: minVis(Ls.visibility, Rs.visibility, Lh.visibility, Rh.visibility),
    shoulderTilt: minVis(Ls.visibility, Rs.visibility),
    hipTilt: minVis(Lh.visibility, Rh.visibility),
  };

  return {
    leftElbow: angle2DAt(Ls, Le, Lw),
    rightElbow: angle2DAt(Rs, Re, Rw),
    leftShoulder: angle2DAt(Lh, Ls, Le),
    rightShoulder: angle2DAt(Rh, Rs, Re),
    leftHip: angle2DAt(Ls, Lh, Lk),
    rightHip: angle2DAt(Rs, Rh, Rk),
    leftKnee: angle2DAt(Lh, Lk, La),
    rightKnee: angle2DAt(Rh, Rk, Ra),
    torsoLean: angle2DBetween(UP_2D, shoulderMid),
    shoulderTilt: angle2DBetween(RIGHT_2D, { x: Rs.x - Ls.x, y: Rs.y - Ls.y }),
    hipTilt: angle2DBetween(RIGHT_2D, { x: Rh.x - Lh.x, y: Rh.y - Lh.y }),
    confidence,
  };
}
