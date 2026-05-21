// Persistent state for "did the user complete the one-time framing
// onboarding?" Per SPECK §4 the first camera-using screen routes the user
// through /onboarding/frame-check; once they've calibrated we never ask
// again unless they hit "re-calibrate" from /profile.

const LS_KEY = 'groove.framing_calibrated.v1';

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
