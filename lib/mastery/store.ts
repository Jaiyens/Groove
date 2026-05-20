// localStorage-backed mastery tracker.
//
// EMA(alpha=0.4): newMastery = alpha * normalizedScore + (1-alpha) * oldMastery
// where normalizedScore = perSkillScore[0..100] / 100. Bootstraps from 0.
//
// The storage interface is abstracted so the same logic runs in the browser
// (localStorage), in node tests (in-memory), and is trivial to port to Swift
// (UserDefaults). No DOM imports needed.

import type { AttemptRecord, MasterySnapshot, MasteryRecord } from './types';

export interface StorageBackend {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'groove.mastery.v1';
const ATTEMPTS_RING_SIZE = 100;
export const EMA_ALPHA = 0.4;

class InMemoryBackend implements StorageBackend {
  private map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

function defaultSnapshot(): MasterySnapshot {
  return { version: 1, mastery: {}, attempts: [] };
}

export class MasteryStore {
  private snapshot: MasterySnapshot;
  constructor(private backend: StorageBackend) {
    const raw = backend.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as MasterySnapshot;
        if (parsed && parsed.version === 1) {
          this.snapshot = parsed;
          return;
        }
      } catch {
        // fall through to fresh snapshot
      }
    }
    this.snapshot = defaultSnapshot();
  }

  private persist() {
    this.backend.setItem(STORAGE_KEY, JSON.stringify(this.snapshot));
  }

  recordAttempt(
    danceId: string,
    perSkillScores: Record<string, number>,
    overallScore?: number,
  ): AttemptRecord {
    const now = Date.now();
    const record: AttemptRecord = {
      attempt_id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      dance_id: danceId,
      timestamp_ms: now,
      overall_score:
        overallScore ?? meanOf(Object.values(perSkillScores)) ?? 0,
      per_skill_scores: { ...perSkillScores },
    };
    this.snapshot.attempts.push(record);
    if (this.snapshot.attempts.length > ATTEMPTS_RING_SIZE) {
      this.snapshot.attempts = this.snapshot.attempts.slice(-ATTEMPTS_RING_SIZE);
    }
    for (const [skillId, score] of Object.entries(perSkillScores)) {
      const normalized = clamp01(score / 100);
      const existing = this.snapshot.mastery[skillId];
      const prev = existing?.mastery ?? 0;
      const newMastery = EMA_ALPHA * normalized + (1 - EMA_ALPHA) * prev;
      const updated: MasteryRecord = {
        skill_id: skillId,
        mastery: clamp01(newMastery),
        attempts: (existing?.attempts ?? 0) + 1,
        last_updated_ms: now,
      };
      this.snapshot.mastery[skillId] = updated;
    }
    this.persist();
    return record;
  }

  getMastery(skillId: string): number {
    return this.snapshot.mastery[skillId]?.mastery ?? 0;
  }

  getAllMastery(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(this.snapshot.mastery)) {
      out[k] = v.mastery;
    }
    return out;
  }

  getAttempts(danceId?: string): AttemptRecord[] {
    if (!danceId) return [...this.snapshot.attempts];
    return this.snapshot.attempts.filter((a) => a.dance_id === danceId);
  }

  getLatestAttempt(danceId: string): AttemptRecord | undefined {
    for (let i = this.snapshot.attempts.length - 1; i >= 0; i--) {
      const a = this.snapshot.attempts[i];
      if (a && a.dance_id === danceId) return a;
    }
    return undefined;
  }

  getAttemptById(id: string): AttemptRecord | undefined {
    return this.snapshot.attempts.find((a) => a.attempt_id === id);
  }

  attemptCountForDance(danceId: string): number {
    return this.snapshot.attempts.reduce(
      (n, a) => (a.dance_id === danceId ? n + 1 : n),
      0,
    );
  }

  exportAsJSON(): string {
    return JSON.stringify(this.snapshot, null, 2);
  }

  importFromJSON(json: string): void {
    const parsed = JSON.parse(json) as MasterySnapshot;
    if (parsed.version !== 1) {
      throw new Error(`unsupported mastery snapshot version: ${parsed.version}`);
    }
    this.snapshot = parsed;
    this.persist();
  }

  reset(): void {
    this.snapshot = defaultSnapshot();
    this.persist();
  }
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function meanOf(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

let _singleton: MasteryStore | null = null;

// Returns the process-wide MasteryStore singleton. Uses localStorage when
// available (browser) and an in-memory backend otherwise (SSR, tests).
export function getMasteryStore(): MasteryStore {
  if (_singleton) return _singleton;
  const backend: StorageBackend =
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as { localStorage?: Storage }).localStorage !== 'undefined'
      ? ((globalThis as { localStorage: Storage }).localStorage as StorageBackend)
      : new InMemoryBackend();
  _singleton = new MasteryStore(backend);
  return _singleton;
}

// For tests: drop the singleton so a fresh in-memory store gets used.
export function _resetMasteryStoreSingleton(): void {
  _singleton = null;
}

export { InMemoryBackend };
