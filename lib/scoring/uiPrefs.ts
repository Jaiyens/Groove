// LocalStorage-backed flags for Mode B UI choices that the user (or dev)
// can flip without reaching for a build flag.

const DUAL_OVERLAY_KEY = 'groove.modeB.dualOverlay.v1';

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

// Default ON for development. End-user release can flip the default by
// changing the fallback below; we still let the user override via the
// in-page toggle button.
export function isDualOverlayEnabled(): boolean {
  if (!isBrowser()) return true;
  try {
    const v = localStorage.getItem(DUAL_OVERLAY_KEY);
    if (v === null) return true;
    return v === '1';
  } catch {
    return true;
  }
}

export function setDualOverlayEnabled(on: boolean): void {
  if (!isBrowser()) return;
  try {
    localStorage.setItem(DUAL_OVERLAY_KEY, on ? '1' : '0');
  } catch {
    // best effort
  }
}
