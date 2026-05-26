'use client';

// Just-Dance-style decorative callouts that pop onto the duet screen
// every couple of beats while the user dances. PURELY decoration —
// no pose comparison, no grading. The words are randomized from a
// fixed pool so the user always feels rewarded.
//
// Cadence is locked to the dance's BPM so the words feel musical:
// one callout every 2 beats. A small ±100ms jitter on each interval
// stops it feeling like a metronome.
//
// Words are placed in the upper-middle of the camera panel, animated
// in (pop + fade), held briefly, animated out.

import { useEffect, useState } from 'react';

interface Props {
  // The dance's tempo. We fire roughly every 2 beats of this.
  bpm: number;
  // When false, no callouts fire (preroll, paused, finished). The
  // page controls this so the words only appear during the actual
  // dance.
  active: boolean;
  // Hooks for future weighting by difficulty. Ignored for now per
  // user direction ("just fully randomize for the time being").
  difficulty?: 'easy' | 'medium' | 'hard';
}

// User-picked vocabulary. Keep it small and unambiguously positive —
// these never affect the real Gemini score.
const WORDS = ['Groovy', 'Perfect', 'Great'] as const;

// How many beats between callouts. 2 means one callout every 2 beats
// (a half-bar in 4/4) — feels musical without overwhelming.
const BEATS_PER_CALLOUT = 2;
const JITTER_MS = 100;
// How long each callout stays on screen before fading. Should be
// short enough that two callouts never visibly overlap.
const VISIBLE_MS = 900;

interface Callout {
  id: number;
  word: string;
}

export default function LiveCallouts({ bpm, active }: Props) {
  const [callout, setCallout] = useState<Callout | null>(null);

  useEffect(() => {
    if (!active) {
      setCallout(null);
      return;
    }
    // Bail out cleanly if the BPM is bogus — fall back to ~120 so
    // there's at least some cadence rather than a null timer.
    const safeBpm = Number.isFinite(bpm) && bpm > 30 ? bpm : 120;
    const beatMs = 60_000 / safeBpm;
    const baseInterval = beatMs * BEATS_PER_CALLOUT;

    let calloutSeq = 0;
    let timeoutId: number | null = null;
    let hideTimeoutId: number | null = null;

    const fire = () => {
      calloutSeq += 1;
      const word = WORDS[Math.floor(Math.random() * WORDS.length)]!;
      setCallout({ id: calloutSeq, word });
      if (hideTimeoutId !== null) window.clearTimeout(hideTimeoutId);
      hideTimeoutId = window.setTimeout(() => {
        // Only clear if this is still the active callout — a fast
        // followup might have replaced it.
        setCallout((current) => (current && current.id === calloutSeq ? null : current));
      }, VISIBLE_MS);

      const jitter = (Math.random() * 2 - 1) * JITTER_MS;
      timeoutId = window.setTimeout(fire, baseInterval + jitter);
    };

    // First callout fires after one full interval — gives the user a
    // beat to look at the reference before words start flying.
    timeoutId = window.setTimeout(fire, baseInterval);

    return () => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      if (hideTimeoutId !== null) window.clearTimeout(hideTimeoutId);
      setCallout(null);
    };
  }, [bpm, active]);

  if (!callout) return null;

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-[18%] z-30 flex justify-center"
    >
      <span
        // Re-mount on every callout change so the keyframes restart.
        // `key={callout.id}` does that for us.
        key={callout.id}
        className="live-callout"
      >
        {callout.word}
      </span>
    </div>
  );
}
