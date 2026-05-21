// Persistent state for "did the user complete the one-time framing
// onboarding?" Per SPECK §4 the first camera-using screen routes the user
// through /onboarding/frame-check; once they've calibrated we never ask
// again unless they hit "re-calibrate" from /profile.

const LS_KEY = 'groove.framing_calibrated.v1';
// sessionStorage handoff: spec.md round-5 §Fix 2. The framing-check
// screen sets a timestamp when it dismisses, and Mode A reads it on
// mount. If it's fresh (<5 s) Mode A skips its own countdown — the
// user just heard 5-4-3-2-1-GO seconds ago and they're across the
// room, so making them tap "start" again is broken UX. Stale or
// missing flag → Mode A keeps its safety-net StartOverlay for the
// browser-back / deep-link path.
const SS_GATE_KEY = 'groove.framing_gate_just_fired.v1';
const GATE_FRESHNESS_MS = 5000;

export function isFramingCalibrated(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(LS_KEY) === '1';
  } catch {
    return true; // SSR / cookies-disabled — don't gate the user.
  }
}

export function markFramingCalibrated(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LS_KEY, '1');
  } catch {
    /* private mode — best-effort, don't block. */
  }
}

export function clearFramingCalibrated(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
}

export function markFramingGateJustFired(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(SS_GATE_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
}

// Returns true if the framing gate fired within the last
// GATE_FRESHNESS_MS ms. Consumes (clears) the flag in the process so
// chained mounts don't all skip — only the route the user landed on
// immediately after framing benefits.
export function consumeFramingGateRecent(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const raw = window.sessionStorage.getItem(SS_GATE_KEY);
    if (!raw) return false;
    window.sessionStorage.removeItem(SS_GATE_KEY);
    const ts = Number(raw);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts <= GATE_FRESHNESS_MS;
  } catch {
    return false;
  }
}
