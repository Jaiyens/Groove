// Mirror preference — single source of truth for whether the reference
// dancer is rendered horizontally flipped.
//
// SPECK overnight Group 2 §mirror-unification: three surfaces render the
// reference video (Mode A copy page, holding screen REF panel, the Gemini
// composite reference input) and were drifting out of sync — Mode A had a
// hardcoded scaleX(-1), the holding screen was un-mirrored, and Gemini's
// `trimReferenceClientSide` hardcoded a canvas flip. This module gives
// all three a shared persisted boolean + a window-event channel so a
// toggle in one surface is reflected in the others without prop-drilling.
//
// Storage key (`groov_mirror_enabled`) is preserved from Mode A's
// previous local-only useState/useEffect pair so a user with the
// preference already stored doesn't lose it on first run after this
// change.
//
// SSR safety: `getMirrorEnabled` is called during component initializers
// (useState(() => getMirrorEnabled())). It must not throw and must not
// touch `window` or `localStorage` directly when running on the server.
// Default OFF — users see the reference in its natural orientation;
// the toggle lets them mirror it if that's easier to follow.

const STORAGE_KEY = 'groov_mirror_enabled';
const EVENT_NAME = 'groov:mirror-changed';

// Returns the current persisted preference, or false on first run / SSR.
// Cheap, synchronous — safe to call from render.
export function getMirrorEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const storage = window.localStorage ?? globalThis.localStorage;
    const v = storage.getItem(STORAGE_KEY);
    return v === null ? false : v === 'true';
  } catch {
    // localStorage can throw in private-mode iOS Safari or when storage
    // is disabled. Treat the failure as "no preference set" → default off.
    return false;
  }
}

// Persist a new value and broadcast it. Other surfaces subscribed via
// `onMirrorChanged` see the new value within the same tick. Calls in
// non-browser environments are no-ops so server-rendered code paths
// remain safe.
export function setMirrorEnabled(enabled: boolean): void {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch {
    // Ignore — the dispatch still fires so the in-tab state stays
    // coherent even when the persistence layer is unavailable.
  }
  try {
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: enabled }));
  } catch {
    // CustomEvent constructor is unavailable on very old browsers; we
    // tolerate the failure rather than crash a surface that just wants
    // to flip its own state.
  }
}

// Subscribe to changes broadcast by `setMirrorEnabled`. Returns an
// unsubscribe function — pair with useEffect cleanup. The handler
// receives the new boolean, not the event object, to keep callsites
// terse: `useEffect(() => onMirrorChanged(setMirror), [])`.
export function onMirrorChanged(handler: (enabled: boolean) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = (e: Event) => {
    // `detail` is unknown to TS without a CustomEvent generic. Re-cast
    // narrowly so a caller dispatching the event with a non-boolean
    // payload doesn't crash the handler.
    const detail = (e as CustomEvent).detail;
    if (typeof detail === 'boolean') handler(detail);
  };
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}

// Exposed for tests that want to assert on the storage key contract
// without hardcoding the string in their fixtures.
export const MIRROR_PREFERENCE_STORAGE_KEY = STORAGE_KEY;
export const MIRROR_PREFERENCE_EVENT_NAME = EVENT_NAME;
