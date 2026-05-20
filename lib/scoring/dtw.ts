// Dynamic Time Warping with Sakoe-Chiba band constraint.
//
// Standard algorithm:
//   D[i][j] = local(i,j) + min(D[i-1][j], D[i][j-1], D[i-1][j-1])
// Constrained to |i*N/M - j| <= window, where window ≈ 10% of max(M, N).
// Backtrack from D[N-1][M-1] to D[0][0] for the alignment path.
//
// Pure TS, no DOM. Swift port is mechanical.

import type { JointAngleVector } from '@/lib/pose/types';
import { euclidean } from './similarity';
import type { DTWResult } from './types';

const INF = Number.POSITIVE_INFINITY;

export function dtw(
  user: JointAngleVector[],
  reference: JointAngleVector[],
  windowSize?: number,
): DTWResult {
  const N = user.length;
  const M = reference.length;
  if (N === 0 || M === 0) {
    return { cost: 0, path: [] };
  }

  const w = Math.max(
    windowSize ?? Math.ceil(Math.max(N, M) * 0.1),
    Math.abs(N - M),
  );
  const scaleNM = N / M;

  // Allocate (N x M) cost matrix as a flat Float64Array.
  const D = new Float64Array(N * M);
  D.fill(INF);
  const idx = (i: number, j: number) => i * M + j;

  // Bounds for the Sakoe-Chiba band centered on the diagonal.
  const inBand = (i: number, j: number) => Math.abs(i - j * scaleNM) <= w;

  for (let i = 0; i < N; i++) {
    const jLo = Math.max(0, Math.floor(i / scaleNM) - w);
    const jHi = Math.min(M - 1, Math.ceil(i / scaleNM) + w);
    for (let j = jLo; j <= jHi; j++) {
      if (!inBand(i, j)) continue;
      const local = euclidean(user[i]!, reference[j]!);
      if (i === 0 && j === 0) {
        D[idx(i, j)] = local;
        continue;
      }
      const a = i > 0 && j > 0 ? D[idx(i - 1, j - 1)]! : INF;
      const b = i > 0 ? D[idx(i - 1, j)]! : INF;
      const c = j > 0 ? D[idx(i, j - 1)]! : INF;
      const minPrev = Math.min(a, b, c);
      D[idx(i, j)] = local + (Number.isFinite(minPrev) ? minPrev : INF);
    }
  }

  const cost = D[idx(N - 1, M - 1)] ?? INF;
  // Backtrack for the alignment path.
  const path: Array<[number, number]> = [];
  let i = N - 1;
  let j = M - 1;
  path.push([i, j]);
  while (i > 0 || j > 0) {
    if (i === 0) {
      j--;
    } else if (j === 0) {
      i--;
    } else {
      const a = D[idx(i - 1, j - 1)] ?? INF;
      const b = D[idx(i - 1, j)] ?? INF;
      const c = D[idx(i, j - 1)] ?? INF;
      const min = Math.min(a, b, c);
      if (min === a) {
        i--;
        j--;
      } else if (min === b) {
        i--;
      } else {
        j--;
      }
    }
    path.push([i, j]);
  }
  path.reverse();
  return { cost: Number.isFinite(cost) ? cost : INF, path };
}
