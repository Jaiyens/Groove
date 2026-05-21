'use client';

// Camera-permission UX banner. Replaces the silent "no camera" state.
// Distinguishes between:
//   - secure-context missing (HTTPS required) — most common phone failure
//   - permission not yet requested
//   - permission denied
//   - mediaDevices unavailable (very old browser)
//
// The HTTPS hint is the load-bearing one: visiting the LAN dev URL over
// http:// silently blocks getUserMedia on iOS Safari / Android Chrome.

export type CamState =
  | 'idle'
  | 'requesting'
  | 'granted'
  | 'needs_tap'
  | 'denied'
  | 'insecure'
  | 'unavailable';

export function isInsecureContext(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.isSecureContext) return false;
  // localhost is treated as secure by every modern browser.
  const h = window.location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return false;
  return true;
}

interface Props {
  state: CamState;
  onRequest: () => void;
  // Compact mode renders for the bottom-half of the duet view rather than a
  // standalone screen. Same content, tighter padding.
  compact?: boolean;
}

export default function CameraPermissionBanner({
  state,
  onRequest,
  compact = false,
}: Props) {
  if (state === 'granted') return null;
  const padding = compact ? 'p-4' : 'p-8';
  const titleSize = compact ? 'text-base font-semibold' : 'text-xl font-semibold';
  const subSize = compact ? 'text-xs' : 'text-sm';

  return (
    <div
      className={`absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/90 text-center ${padding}`}
      role="status"
    >
      {state === 'requesting' && (
        <>
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
          <div className={`mt-3 ${subSize} text-white/70`}>requesting camera…</div>
        </>
      )}

      {state === 'needs_tap' && (
        <>
          <div className={`${titleSize} text-white`}>tap to enable camera</div>
          <p className={`mt-2 ${subSize} max-w-xs text-white/60`}>
            iOS needs a tap before it’ll start the camera.
          </p>
          <button
            type="button"
            onClick={onRequest}
            className="mt-4 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black"
          >
            enable camera
          </button>
        </>
      )}

      {state === 'idle' && (
        <>
          <div className={`${titleSize} text-white`}>camera off</div>
          <button
            type="button"
            onClick={onRequest}
            className="mt-4 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black"
          >
            enable camera
          </button>
        </>
      )}

      {state === 'denied' && (
        <>
          <div className={`${titleSize} text-white`}>camera blocked</div>
          <p className={`mt-2 ${subSize} max-w-xs text-white/60`}>
            you previously denied camera access. enable it in your
            browser site settings, then reload.
          </p>
          <button
            type="button"
            onClick={onRequest}
            className="mt-4 rounded-full bg-white/15 px-5 py-2.5 text-sm font-semibold text-white ring-1 ring-white/20"
          >
            try again
          </button>
        </>
      )}

      {state === 'insecure' && (
        <>
          <div className={`${titleSize} text-white`}>https required</div>
          <p className={`mt-2 ${subSize} max-w-xs text-white/60`}>
            browsers only allow camera access over https. open this site
            on a phone via an https URL — see BLOCKERS.md §4 for the
            one-line dev-server fix.
          </p>
        </>
      )}

      {state === 'unavailable' && (
        <>
          <div className={`${titleSize} text-white`}>camera unavailable</div>
          <p className={`mt-2 ${subSize} max-w-xs text-white/60`}>
            this browser doesn’t expose a camera API. try Safari (iOS) or
            Chrome (Android / desktop).
          </p>
        </>
      )}
    </div>
  );
}
