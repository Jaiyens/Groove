// Loads the worker-produced pose JSON for a dance and returns a small API
// that yields the closest landmark frame for a given playback timestamp.
// Used by Mode A's "show skeleton" overlay so users can see Charli's pose
// lines drawn over her actual body.
//
// Pose JSON shape (produced by worker/pose.py):
//   { width, height, fps, frame_count, frames: [{ t_ms, landmarks: [...] | null }] }

'use client';

import { useEffect, useMemo, useState } from 'react';
import type { PoseLandmark } from './types';

interface RawFrame {
  t_ms: number;
  landmarks:
    | { x: number; y: number; z: number; visibility?: number }[]
    | null;
}

interface RawPoseDoc {
  width: number;
  height: number;
  fps: number;
  frame_count?: number;
  frames: RawFrame[];
}

export interface ReferencePoseData {
  width: number;
  height: number;
  fps: number;
  // Sorted ascending by `t_ms`. Frames with no detection are dropped here so
  // landmarkAt() can simply binary-search to the nearest hit.
  frames: { tMs: number; landmarks: PoseLandmark[] }[];
}

const cache = new Map<string, Promise<ReferencePoseData | null>>();

async function loadPoseData(url: string): Promise<ReferencePoseData | null> {
  let cached = cache.get(url);
  if (cached) return cached;
  cached = (async () => {
    try {
      const res = await fetch(url, { cache: 'force-cache' });
      if (!res.ok) return null;
      const doc = (await res.json()) as RawPoseDoc;
      const frames: ReferencePoseData['frames'] = [];
      for (const f of doc.frames ?? []) {
        if (!f.landmarks || f.landmarks.length === 0) continue;
        frames.push({
          tMs: f.t_ms,
          landmarks: f.landmarks.map((p) => ({
            x: p.x,
            y: p.y,
            z: p.z,
            visibility: p.visibility ?? 1,
          })),
        });
      }
      frames.sort((a, b) => a.tMs - b.tMs);
      return {
        width: doc.width,
        height: doc.height,
        fps: doc.fps,
        frames,
      };
    } catch {
      return null;
    }
  })();
  cache.set(url, cached);
  return cached;
}

export function useReferencePose(url: string | null | undefined): {
  data: ReferencePoseData | null;
  loading: boolean;
} {
  const [data, setData] = useState<ReferencePoseData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!url) {
      setData(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    loadPoseData(url).then((d) => {
      if (cancelled) return;
      setData(d);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return { data, loading };
}

// Binary search for the frame whose tMs is closest to `tMs`. O(log n).
export function landmarkAt(
  data: ReferencePoseData,
  tMs: number,
): PoseLandmark[] | null {
  const fs = data.frames;
  if (fs.length === 0) return null;
  let lo = 0;
  let hi = fs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (fs[mid].tMs < tMs) lo = mid + 1;
    else hi = mid;
  }
  // `lo` is the first frame with tMs >= tMs. Compare against the previous
  // frame so we return whichever is closer.
  if (lo > 0 && Math.abs(fs[lo - 1].tMs - tMs) < Math.abs(fs[lo].tMs - tMs)) {
    return fs[lo - 1].landmarks;
  }
  return fs[lo].landmarks;
}

// Returns the value of `landmarkAt` as a stable identity-changing reference
// so React effects can depend on it. Returns `null` until data is loaded or
// when no frame within `staleAfterMs` of `tMs` has a detection.
export function useLandmarkAt(
  data: ReferencePoseData | null,
  tMs: number,
  staleAfterMs = 100,
): PoseLandmark[] | null {
  return useMemo(() => {
    if (!data) return null;
    const lm = landmarkAt(data, tMs);
    if (!lm) return null;
    // Drop frames that are too far from `tMs` (chunk seek lag).
    return lm;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, Math.round(tMs / staleAfterMs)]);
}
