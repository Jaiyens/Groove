// Pose types — pure data, no browser/DOM dependencies. Maps directly to Swift
// structs when we port to iOS native (Vision uses the same 33-landmark BlazePose
// topology when configured for full-body).

export interface PoseLandmark {
  x: number;
  y: number;
  z: number;
  visibility: number;
}

export interface PoseResult {
  // 33 landmarks in normalized image coords (x,y in 0..1, z relative to hips).
  landmarks: PoseLandmark[];
  // 33 landmarks in world coords (meters, origin at hip midpoint).
  worldLandmarks: PoseLandmark[];
  timestampMs: number;
}

// BlazePose 33-landmark topology indices. Names match MediaPipe so the math in
// jointAngles.ts is easy to verify.
export const LANDMARK = {
  NOSE: 0,
  LEFT_EYE_INNER: 1,
  LEFT_EYE: 2,
  LEFT_EYE_OUTER: 3,
  RIGHT_EYE_INNER: 4,
  RIGHT_EYE: 5,
  RIGHT_EYE_OUTER: 6,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  MOUTH_LEFT: 9,
  MOUTH_RIGHT: 10,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_PINKY: 17,
  RIGHT_PINKY: 18,
  LEFT_INDEX: 19,
  RIGHT_INDEX: 20,
  LEFT_THUMB: 21,
  RIGHT_THUMB: 22,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
} as const;

export type LandmarkIndex = (typeof LANDMARK)[keyof typeof LANDMARK];

// Edges for skeleton drawing. (i, j) pairs index into landmarks[].
export const SKELETON_EDGES: ReadonlyArray<readonly [LandmarkIndex, LandmarkIndex]> = [
  [LANDMARK.LEFT_SHOULDER, LANDMARK.RIGHT_SHOULDER],
  [LANDMARK.LEFT_SHOULDER, LANDMARK.LEFT_ELBOW],
  [LANDMARK.LEFT_ELBOW, LANDMARK.LEFT_WRIST],
  [LANDMARK.RIGHT_SHOULDER, LANDMARK.RIGHT_ELBOW],
  [LANDMARK.RIGHT_ELBOW, LANDMARK.RIGHT_WRIST],
  [LANDMARK.LEFT_SHOULDER, LANDMARK.LEFT_HIP],
  [LANDMARK.RIGHT_SHOULDER, LANDMARK.RIGHT_HIP],
  [LANDMARK.LEFT_HIP, LANDMARK.RIGHT_HIP],
  [LANDMARK.LEFT_HIP, LANDMARK.LEFT_KNEE],
  [LANDMARK.LEFT_KNEE, LANDMARK.LEFT_ANKLE],
  [LANDMARK.RIGHT_HIP, LANDMARK.RIGHT_KNEE],
  [LANDMARK.RIGHT_KNEE, LANDMARK.RIGHT_ANKLE],
];

// Joint-angle vector — degrees for angles, meters for displacements/leans.
// Record form chosen over fixed-length array for JSON readability and Swift
// Codable compatibility.
export type JointName =
  | 'left_elbow'
  | 'right_elbow'
  | 'left_shoulder'
  | 'right_shoulder'
  | 'left_hip'
  | 'right_hip'
  | 'left_knee'
  | 'right_knee'
  | 'torso_lean'
  | 'hip_rotation_y'
  | 'chest_forward_z';

export const JOINT_NAMES: readonly JointName[] = [
  'left_elbow',
  'right_elbow',
  'left_shoulder',
  'right_shoulder',
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
  'torso_lean',
  'hip_rotation_y',
  'chest_forward_z',
] as const;

export type JointAngleVector = Record<JointName, number>;

export interface FrameSample {
  timestampMs: number;
  vector: JointAngleVector;
}
