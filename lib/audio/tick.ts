// Tiny Web Audio API helper for the pre-test countdown beep.
//
// Used by Mode B (and any other "get-ready" surface). 880 Hz sine, 80 ms
// envelope, no external assets. Lazy-initialises an AudioContext on first
// use; calls are no-ops on the server.

'use client';

let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (ctx && ctx.state !== 'closed') return ctx;
  const Klass: typeof AudioContext | undefined =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Klass) return null;
  try {
    ctx = new Klass();
  } catch {
    return null;
  }
  return ctx;
}

interface TickOptions {
  freq?: number;       // Hz, default 880
  durationMs?: number; // default 80
  // 0..1 linear; default 0.25 — the ticks are an in-context cue, not music.
  gain?: number;
  // Optional pitch override; "go" tick is a touch lower and longer so it
  // reads as the resolution beat rather than another count.
  emphasis?: boolean;
}

export function playTick({
  freq,
  durationMs,
  gain = 0.25,
  emphasis = false,
}: TickOptions = {}): void {
  const c = getContext();
  if (!c) return;
  // Autoplay rules: the AudioContext may be suspended until a user gesture.
  // The first tick in a tap-triggered flow will be silent if we don't try
  // to resume here. Best-effort — ignored if it rejects.
  if (c.state === 'suspended') {
    void c.resume().catch(() => {});
  }
  const f = freq ?? (emphasis ? 660 : 880);
  const dur = (durationMs ?? (emphasis ? 160 : 80)) / 1000;
  const now = c.currentTime;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = f;
  // Quick fade-in + exponential decay so we don't hear a click.
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(gain, now + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  osc.connect(g).connect(c.destination);
  osc.start(now);
  osc.stop(now + dur + 0.02);
}
