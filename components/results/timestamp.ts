// Parse the "MM:SS" timestamps Gemini emits into total seconds so the
// mini-replay cards can scrub their videos to that moment. Falls back
// to 0 for malformed input — the card still renders, just from the
// start.

export function parseMmSs(ts: string | null | undefined): number {
  if (!ts) return 0;
  const m = ts.trim().match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return 0;
  const minutes = Number(m[1]);
  const seconds = Number(m[2]);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return 0;
  return minutes * 60 + seconds;
}
