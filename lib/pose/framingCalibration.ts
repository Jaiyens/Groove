// Persistent state for whether the user has completed the framing check.
// The first camera-using screen routes through /onboarding/frame-check;
// completing or skipping it keeps future chunk taps from bouncing back.

const LS_KEY = 'groove.framing_calibrated.v1';

export function isFramingCalibrated(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(LS_KEY) === '1';
  } catch {
    return true;
  }
}

export function markFramingCalibrated(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LS_KEY, '1');
  } catch {
    /* private mode - best effort only */
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
