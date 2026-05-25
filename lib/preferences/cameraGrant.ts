// Session-scoped flag: did the user already grant camera permission this
// session? When set we can silently re-attach the stream on subsequent
// chunks instead of flashing the "enable camera" CTA between every
// navigation. The browser remembers the permission decision for the
// origin, so the re-grant is essentially instant.

const KEY = 'groove.camera-granted.v1';

export function markCameraGranted(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(KEY, '1');
  } catch {
    /* private browsing or storage disabled — ignore */
  }
}

export function wasCameraGranted(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}
