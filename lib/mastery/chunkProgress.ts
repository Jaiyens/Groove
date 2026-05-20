// Per-dance chunk unlock state. Persisted in localStorage alongside mastery.
//
// State machine per chunk:
//   locked → unlocked (always for index 0; for k > 0, when chunk k-1 reaches
//             passed) → passed (Mode B score ≥ threshold).
//
// "Mastered" is currently a soft notion — we treat passed once as good enough
// to advance. A future enhancement could require N consecutive passes.

const STORAGE_KEY = 'groove.chunkProgress.v1';
const PASS_THRESHOLD = 70;

export interface DanceProgress {
  // Highest 0-based chunk index ever passed.
  highestPassed: number;
  // Last score recorded per chunk index (rounded). Sparse map.
  lastScores: Record<number, number>;
}

interface PersistShape {
  [danceId: string]: DanceProgress;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

function readAll(): PersistShape {
  if (!isBrowser()) return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PersistShape;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(data: PersistShape): void {
  if (!isBrowser()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Quota / serialization failure — best effort only.
  }
}

export function getDanceProgress(danceId: string): DanceProgress {
  const all = readAll();
  return all[danceId] ?? { highestPassed: -1, lastScores: {} };
}

// A chunk is unlocked if it's the first chunk OR the previous chunk has
// been passed at least once.
export function isChunkUnlocked(danceId: string, chunkIndex: number): boolean {
  if (chunkIndex <= 0) return true;
  const progress = getDanceProgress(danceId);
  return progress.highestPassed >= chunkIndex - 1;
}

export function isChunkPassed(danceId: string, chunkIndex: number): boolean {
  const progress = getDanceProgress(danceId);
  return progress.highestPassed >= chunkIndex;
}

// Returns true if every chunk in [0, totalChunks) is passed — gates Mode C.
export function isFullUnlocked(danceId: string, totalChunks: number): boolean {
  if (totalChunks <= 0) return false;
  return getDanceProgress(danceId).highestPassed >= totalChunks - 1;
}

export function recordChunkScore(
  danceId: string,
  chunkIndex: number,
  score: number,
): { passed: boolean; unlockedNext: boolean } {
  const rounded = Math.round(score);
  const passed = rounded >= PASS_THRESHOLD;
  const all = readAll();
  const current: DanceProgress = all[danceId] ?? { highestPassed: -1, lastScores: {} };
  current.lastScores = { ...current.lastScores, [chunkIndex]: rounded };
  const previouslyHighest = current.highestPassed;
  if (passed && chunkIndex > current.highestPassed) {
    current.highestPassed = chunkIndex;
  }
  all[danceId] = current;
  writeAll(all);
  const unlockedNext = passed && current.highestPassed > previouslyHighest;
  return { passed, unlockedNext };
}

// Test/debug only.
export function _resetChunkProgress(danceId?: string): void {
  if (!isBrowser()) return;
  if (!danceId) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  const all = readAll();
  delete all[danceId];
  writeAll(all);
}

export { PASS_THRESHOLD };
