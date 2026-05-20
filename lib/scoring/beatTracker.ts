// BPM-based beat tracker. Pure TS — works in node tests.
//
// v1 strategy: spec allows "a hardcoded BPM per reference dance fixture"
// because the trending TikTok dances have known BPMs. Real audio-onset
// detection (Web Audio API + AnalyserNode) is deferred to the iOS port where
// AVFoundation makes onset detection significantly cleaner.

import type { BeatGrid } from './types';

export type BeatListener = (beatIdx: number, atMs: number) => void;

export class BeatTracker {
  private listeners = new Set<BeatListener>();
  private lastEmittedBeat = -1;
  readonly periodMs: number;

  constructor(public readonly bpm: number, public readonly startMs: number = 0) {
    if (bpm <= 0) throw new Error(`BeatTracker: bpm must be > 0, got ${bpm}`);
    this.periodMs = 60_000 / bpm;
  }

  // Returns the 0-based beat index at audioTimeMs. Float; integer part is the
  // beat, fractional part is phase within the beat.
  getCurrentBeat(audioTimeMs: number): number {
    return (audioTimeMs - this.startMs) / this.periodMs;
  }

  msAtBeat(beatIdx: number): number {
    return this.startMs + beatIdx * this.periodMs;
  }

  // Drive the tracker forward by the latest audio time. Emits a beat event for
  // every integer beat crossed since the previous tick. Idempotent within a
  // single beat — multiple ticks in the same beat do not re-emit.
  tick(audioTimeMs: number): void {
    const current = Math.floor(this.getCurrentBeat(audioTimeMs));
    while (this.lastEmittedBeat < current) {
      this.lastEmittedBeat += 1;
      const at = this.msAtBeat(this.lastEmittedBeat);
      for (const fn of this.listeners) fn(this.lastEmittedBeat, at);
    }
  }

  reset(): void {
    this.lastEmittedBeat = -1;
  }

  onBeat(fn: BeatListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // Conform to the BeatGrid interface used by the scorer.
  asGrid(): BeatGrid {
    return {
      bpm: this.bpm,
      startMs: this.startMs,
      getBeatAt: (t: number) => this.getCurrentBeat(t),
      msAtBeat: (b: number) => this.msAtBeat(b),
    };
  }
}

export function createBeatGrid(bpm: number, startMs = 0): BeatGrid {
  return new BeatTracker(bpm, startMs).asGrid();
}
