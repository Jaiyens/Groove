import { getAllDanceProgress } from '@/lib/mastery/chunkProgress';

const FIRST_OPEN_KEY = 'groove.firstOpenAt.v1';
const DANCES_STARTED_KEY = 'groove.dancesStarted.v1';
const DAY_MS = 24 * 60 * 60 * 1000;

interface DanceStartedRecord {
  first_started_ms: number;
}

type DancesStartedShape = Record<string, DanceStartedRecord>;

export interface PracticeStats {
  totalDancesStarted: number;
  totalChunksCompleted: number;
  daysActive: number;
  hasActivity: boolean;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

function readJson<T>(key: string, fallback: T): T {
  if (!isBrowser()) return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson<T>(key: string, value: T): void {
  if (!isBrowser()) return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Best effort only; stats should never block practice.
  }
}

export function ensureFirstOpenTimestamp(): number {
  if (!isBrowser()) return Date.now();
  const existing = Number(localStorage.getItem(FIRST_OPEN_KEY));
  if (Number.isFinite(existing) && existing > 0) return existing;

  const now = Date.now();
  try {
    localStorage.setItem(FIRST_OPEN_KEY, String(now));
  } catch {
    // Ignore storage failures; callers still get a sensible value.
  }
  return now;
}

export function markDanceStarted(danceId: string): void {
  if (!isBrowser() || !danceId) return;
  ensureFirstOpenTimestamp();
  const started = readJson<DancesStartedShape>(DANCES_STARTED_KEY, {});
  if (started[danceId]) return;

  writeJson<DancesStartedShape>(DANCES_STARTED_KEY, {
    ...started,
    [danceId]: { first_started_ms: Date.now() },
  });
}

export function getPracticeStats(): PracticeStats {
  const firstOpenMs = ensureFirstOpenTimestamp();
  const started = readJson<DancesStartedShape>(DANCES_STARTED_KEY, {});
  const progress = getAllDanceProgress();
  const startedDanceIds = new Set(Object.keys(started));
  for (const [danceId, danceProgress] of Object.entries(progress)) {
    if (
      danceProgress.highestPassed >= 0 ||
      Object.keys(danceProgress.lastScores).length > 0
    ) {
      startedDanceIds.add(danceId);
    }
  }
  const totalChunksCompleted = Object.values(progress).reduce(
    (sum, dance) => sum + Math.max(0, dance.highestPassed + 1),
    0,
  );

  const elapsedDays = Math.floor((Date.now() - firstOpenMs) / DAY_MS) + 1;
  const totalDancesStarted = startedDanceIds.size;

  return {
    totalDancesStarted,
    totalChunksCompleted,
    daysActive: Math.max(1, elapsedDays),
    hasActivity: totalDancesStarted > 0 || totalChunksCompleted > 0,
  };
}
