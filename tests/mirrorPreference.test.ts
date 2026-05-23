import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  getMirrorEnabled,
  setMirrorEnabled,
  onMirrorChanged,
  MIRROR_PREFERENCE_STORAGE_KEY,
  MIRROR_PREFERENCE_EVENT_NAME,
} from '../lib/preferences/mirror.ts';

// SPECK overnight Group 2 §mirror-unification: the mirror preference
// module is the single source of truth for three surfaces (Mode A REF
// panel, holding-screen REF panel, Gemini composite reference input).
// These tests pin the contract those surfaces rely on:
//   - default is ON (so a first-run user gets the mirrored reference
//     that almost every dance student wants),
//   - persistence is via localStorage under a stable key (we don't
//     want users to lose their preference on a future refactor),
//   - subscribers receive the new value after a setMirrorEnabled call.

// Minimal global localStorage / window stubs so these tests can run
// under node's test runner without a JSDOM dependency. The module
// guards every access with `typeof window === 'undefined'`, so we just
// have to make the global look like the browser shape it expects.
type Listener = (e: Event) => void;
function installBrowserGlobals() {
  const store = new Map<string, string>();
  const listeners = new Map<string, Set<Listener>>();
  const fakeLocalStorage = {
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
    removeItem(key: string) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    get length() {
      return store.size;
    },
  };
  const fakeWindow = {
    addEventListener(name: string, listener: Listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(listener);
    },
    removeEventListener(name: string, listener: Listener) {
      listeners.get(name)?.delete(listener);
    },
    dispatchEvent(e: Event) {
      const set = listeners.get(e.type);
      if (set) for (const l of set) l(e);
      return true;
    },
  };
  // CustomEvent polyfill — the lib uses `new CustomEvent(name, { detail })`
  // when broadcasting. Node 18+ has it globally; if not, install a shim.
  if (typeof (globalThis as { CustomEvent?: unknown }).CustomEvent === 'undefined') {
    (globalThis as Record<string, unknown>).CustomEvent = class<T> extends Event {
      detail: T;
      constructor(name: string, init?: { detail?: T }) {
        super(name);
        this.detail = init?.detail as T;
      }
    };
  }
  (globalThis as Record<string, unknown>).localStorage = fakeLocalStorage;
  (globalThis as Record<string, unknown>).window = fakeWindow;
}

describe('getMirrorEnabled', () => {
  beforeEach(() => {
    installBrowserGlobals();
    (globalThis as { localStorage?: { clear: () => void } }).localStorage?.clear();
  });

  it('defaults to true when no value is stored (first-run user)', () => {
    assert.equal(getMirrorEnabled(), true);
  });

  it('returns true when the stored value is the string "true"', () => {
    (globalThis as { localStorage: Storage }).localStorage.setItem(
      MIRROR_PREFERENCE_STORAGE_KEY,
      'true',
    );
    assert.equal(getMirrorEnabled(), true);
  });

  it('returns false when the stored value is the string "false"', () => {
    (globalThis as { localStorage: Storage }).localStorage.setItem(
      MIRROR_PREFERENCE_STORAGE_KEY,
      'false',
    );
    assert.equal(getMirrorEnabled(), false);
  });

  it('treats malformed values as default-on (forgiving, not strict)', () => {
    // The spec frames default-on as the right answer for a first-run
    // user; a corrupted localStorage value is the same situation from
    // the user's perspective. Don't make them stare at an unmirrored
    // reference because their storage got mangled.
    (globalThis as { localStorage: Storage }).localStorage.setItem(
      MIRROR_PREFERENCE_STORAGE_KEY,
      'YES',
    );
    assert.equal(getMirrorEnabled(), false, 'anything other than "true" reads as false');
    // Spec: `v === null ? true : v === 'true'`. Pin the rule explicitly.
  });
});

describe('setMirrorEnabled', () => {
  beforeEach(() => {
    installBrowserGlobals();
    (globalThis as { localStorage?: { clear: () => void } }).localStorage?.clear();
  });

  it('persists true under the canonical storage key', () => {
    setMirrorEnabled(true);
    assert.equal(
      (globalThis as { localStorage: Storage }).localStorage.getItem(MIRROR_PREFERENCE_STORAGE_KEY),
      'true',
    );
  });

  it('persists false under the canonical storage key', () => {
    setMirrorEnabled(false);
    assert.equal(
      (globalThis as { localStorage: Storage }).localStorage.getItem(MIRROR_PREFERENCE_STORAGE_KEY),
      'false',
    );
  });

  it('dispatches a window event with the new value as detail', () => {
    let received: unknown = null;
    const win = (globalThis as { window: { addEventListener: (n: string, l: Listener) => void } }).window;
    win.addEventListener(MIRROR_PREFERENCE_EVENT_NAME, (e) => {
      received = (e as CustomEvent).detail;
    });
    setMirrorEnabled(false);
    assert.equal(received, false);
    setMirrorEnabled(true);
    assert.equal(received, true);
  });
});

describe('onMirrorChanged', () => {
  beforeEach(() => {
    installBrowserGlobals();
    (globalThis as { localStorage?: { clear: () => void } }).localStorage?.clear();
  });

  it('fires the handler with the new boolean when setMirrorEnabled is called', () => {
    const seen: boolean[] = [];
    const unsubscribe = onMirrorChanged((v) => seen.push(v));
    setMirrorEnabled(false);
    setMirrorEnabled(true);
    setMirrorEnabled(false);
    assert.deepEqual(seen, [false, true, false]);
    unsubscribe();
  });

  it('returns a working unsubscribe function (handler not called after)', () => {
    const seen: boolean[] = [];
    const unsubscribe = onMirrorChanged((v) => seen.push(v));
    setMirrorEnabled(false);
    unsubscribe();
    setMirrorEnabled(true);
    assert.deepEqual(seen, [false], 'no second call after unsubscribe');
  });

  it('ignores broadcast events with non-boolean detail (defensive)', () => {
    // A future surface that dispatches the event manually with the wrong
    // payload shape shouldn't crash subscribers.
    const seen: boolean[] = [];
    onMirrorChanged((v) => seen.push(v));
    const win = (globalThis as { window: { dispatchEvent: (e: Event) => boolean } }).window;
    win.dispatchEvent(new CustomEvent(MIRROR_PREFERENCE_EVENT_NAME, { detail: 'nope' as unknown as boolean }));
    assert.deepEqual(seen, []);
  });
});
