// Cosine similarity over joint-angle vectors. Pure TS — port to Swift directly.

import { JOINT_NAMES, type JointAngleVector } from '@/lib/pose/types';

export function cosineSimilarity(a: JointAngleVector, b: JointAngleVector): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const k of JOINT_NAMES) {
    const av = a[k] ?? 0;
    const bv = b[k] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom < 1e-9) return 0;
  return dot / denom;
}

// Euclidean distance over joint-angle vectors. Used as DTW local cost.
export function euclidean(a: JointAngleVector, b: JointAngleVector): number {
  let s = 0;
  for (const k of JOINT_NAMES) {
    const d = (a[k] ?? 0) - (b[k] ?? 0);
    s += d * d;
  }
  return Math.sqrt(s);
}
