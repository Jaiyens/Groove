'use client';

// Just-Dance-style decorative callouts that pop onto the duet screen
// every few beats while the user dances. PURELY decoration — no pose
// comparison, no grading. The words are randomized from a fixed
// vocabulary and each word has its own color treatment.
//
// Cadence: between 3 and 7 beats per callout, picked randomly each
// time, so the words feel earned instead of metronomic.
//
// Words sit in the upper-middle of the duet area: scale-in with a
// slight rotation, hold briefly, drift up + fade out.

import { useEffect, useState } from 'react';

interface Props {
  // The dance's tempo. We fire roughly every 3–7 beats of this.
  bpm: number;
  // When false, no callouts fire (preroll, paused, finished). The
  // page controls this so the words only appear during the actual
  // dance.
  active: boolean;
  // Reserved for difficulty-weighted word pools. Ignored for now —
  // user direction was "randomize fully" with the three-word pool.
  difficulty?: 'easy' | 'medium' | 'hard';
}

type CalloutWord = 'Groovy' | 'Perfect' | 'Great';

// Each word gets its own color identity. Groovy is the user-specified
// hot pink. Perfect lands on warm gold (achievement), Great gets a
// cool blue (clean / steady). The shadow color tracks the gradient
// so the words feel like they're glowing in their own light.
const WORD_STYLES: Record<CalloutWord, { gradient: string; shadow: string; ring: string }> = {
  Groovy: {
    gradient: 'linear-gradient(135deg, #FF2D87 0%, #FF6FB1 45%, #FF8FD0 100%)',
    shadow: '0 10px 40px rgba(255, 45, 135, 0.55), 0 0 22px rgba(255, 143, 208, 0.45)',
    ring: 'rgba(255, 255, 255, 0.18)',
  },
  Perfect: {
    gradient: 'linear-gradient(135deg, #FFB300 0%, #FFD24A 50%, #FFE99A 100%)',
    shadow: '0 10px 40px rgba(255, 179, 0, 0.55), 0 0 22px rgba(255, 224, 130, 0.55)',
    ring: 'rgba(120, 80, 0, 0.16)',
  },
  Great: {
    gradient: 'linear-gradient(135deg, #2BD4FF 0%, #6EE7FF 45%, #B6F3FF 100%)',
    shadow: '0 10px 40px rgba(43, 212, 255, 0.55), 0 0 22px rgba(182, 243, 255, 0.5)',
    ring: 'rgba(255, 255, 255, 0.22)',
  },
};

const WORDS = Object.keys(WORD_STYLES) as CalloutWord[];

const MIN_BEATS_BETWEEN = 3;
const MAX_BEATS_BETWEEN = 7;
const VISIBLE_MS = 1100;

interface Callout {
  id: number;
  word: CalloutWord;
}

function pickWord(prev: CalloutWord | null): CalloutWord {
  // Avoid two in a row of the same word — keeps variety high.
  const pool = prev ? WORDS.filter((w) => w !== prev) : WORDS;
  return pool[Math.floor(Math.random() * pool.length)]!;
}

function pickInterval(beatMs: number): number {
  const beats = MIN_BEATS_BETWEEN + Math.random() * (MAX_BEATS_BETWEEN - MIN_BEATS_BETWEEN);
  return beatMs * beats;
}

export default function LiveCallouts({ bpm, active }: Props) {
  const [callout, setCallout] = useState<Callout | null>(null);

  useEffect(() => {
    if (!active) {
      setCallout(null);
      return;
    }
    const safeBpm = Number.isFinite(bpm) && bpm > 30 ? bpm : 120;
    const beatMs = 60_000 / safeBpm;

    let calloutSeq = 0;
    let timeoutId: number | null = null;
    let hideTimeoutId: number | null = null;
    let lastWord: CalloutWord | null = null;

    const fire = () => {
      calloutSeq += 1;
      const word = pickWord(lastWord);
      lastWord = word;
      const id = calloutSeq;
      setCallout({ id, word });
      if (hideTimeoutId !== null) window.clearTimeout(hideTimeoutId);
      hideTimeoutId = window.setTimeout(() => {
        setCallout((current) => (current && current.id === id ? null : current));
      }, VISIBLE_MS);
      timeoutId = window.setTimeout(fire, pickInterval(beatMs));
    };

    // First callout fires after a normal interval — gives the user a
    // beat to look at the reference before words start flying.
    timeoutId = window.setTimeout(fire, pickInterval(beatMs));

    return () => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      if (hideTimeoutId !== null) window.clearTimeout(hideTimeoutId);
      setCallout(null);
    };
  }, [bpm, active]);

  if (!callout) return null;

  const style = WORD_STYLES[callout.word];

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-[16%] z-30 flex justify-center px-4"
    >
      <span
        // Re-mount on every callout change so the keyframes restart.
        key={callout.id}
        className="live-callout"
        style={{
          backgroundImage: style.gradient,
          boxShadow: `${style.shadow}, 0 0 0 2px ${style.ring} inset`,
        }}
      >
        {callout.word}
      </span>
    </div>
  );
}
