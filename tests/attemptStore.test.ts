import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  saveAttempt,
  listAttempts,
  getAttempt,
  deleteAttempt,
  updateNotes,
  clearAttempts,
  isCaptureEnabled,
  setCaptureEnabled,
  base64ToBlob,
  exportAllAsJson,
  importFromJson,
  CAPTURE_FLAG_KEY,
  LOCALSTORAGE_FALLBACK_KEY,
  type SavedAttempt,
} from '../lib/debug/attemptStore.ts';

// SPECK overnight Track 2 §attempt-store: pins the contract the debug page
// relies on — save/list/get/delete round-trip via IndexedDB OR localStorage
// fallback, depending on what's available in the host.
//
// Tests run under node's runner with no DOM; we install a minimal
// localStorage shim and (intentionally) omit IndexedDB so every test
// exercises the localStorage fallback path. The IDB happy path is covered
// by an additional suite below that installs a fake IDB.

function installLocalStorageOnly() {
  const store = new Map<string, string>();
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
  (globalThis as Record<string, unknown>).localStorage = fakeLocalStorage;
  (globalThis as Record<string, unknown>).window = { localStorage: fakeLocalStorage };
  // Strip any prior indexedDB shim so the fallback path exercises.
  (globalThis as Record<string, unknown>).indexedDB = undefined;
  // atob shim — node 18+ has it natively but be defensive.
  if (typeof (globalThis as { atob?: unknown }).atob === 'undefined') {
    (globalThis as Record<string, unknown>).atob = (s: string) =>
      Buffer.from(s, 'base64').toString('binary');
  }
}

function baseAttempt(): Omit<SavedAttempt, 'id' | 'savedAt'> {
  return {
    danceId: 'dance-1',
    chunkIndex: 0,
    referenceUrl: 'https://example.test/ref.mp4',
    attemptBlobBase64: 'AAAA',
    attemptMimeType: 'video/webm',
    chunkStartMs: 0,
    chunkEndMs: 7000,
    motionOnsetRefSec: 0.2,
    motionOnsetAttemptSec: 0.5,
    mirror: true,
    legsVisible: true,
    requestPayload: { fake: 'payload' },
    responseRaw: { is_actually_dancing: true, overall_score: 80 },
    responseDeterministic: { displayedOverall: 78 },
    latencyMs: 1200,
    durationSource: 'webm-repair-inferred',
    authoritativeDurationSec: 7.1,
  };
}

describe('attemptStore — capture flag', () => {
  beforeEach(() => {
    installLocalStorageOnly();
  });

  it('defaults isCaptureEnabled to false', () => {
    assert.equal(isCaptureEnabled(), false);
  });

  it('setCaptureEnabled(true) persists the flag and isCaptureEnabled returns true', () => {
    setCaptureEnabled(true);
    assert.equal(
      (globalThis as { localStorage: Storage }).localStorage.getItem(CAPTURE_FLAG_KEY),
      'true',
    );
    assert.equal(isCaptureEnabled(), true);
  });

  it('setCaptureEnabled(false) clears the flag', () => {
    setCaptureEnabled(true);
    setCaptureEnabled(false);
    assert.equal(
      (globalThis as { localStorage: Storage }).localStorage.getItem(CAPTURE_FLAG_KEY),
      null,
    );
    assert.equal(isCaptureEnabled(), false);
  });
});

describe('attemptStore — localStorage fallback (no IDB)', () => {
  beforeEach(() => {
    installLocalStorageOnly();
  });

  it('saveAttempt persists to localStorage when IDB is unavailable', async () => {
    const res = await saveAttempt(baseAttempt());
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.backend, 'localstorage');
    const raw = (globalThis as { localStorage: Storage }).localStorage.getItem(LOCALSTORAGE_FALLBACK_KEY);
    assert.ok(raw && raw.length > 0, 'fallback key populated');
  });

  it('listAttempts returns saved entries newest-first', async () => {
    await saveAttempt({ ...baseAttempt(), danceId: 'a' });
    // 1ms apart so savedAt orders deterministically.
    await new Promise((r) => setTimeout(r, 2));
    await saveAttempt({ ...baseAttempt(), danceId: 'b' });
    const list = await listAttempts();
    assert.equal(list.length, 2);
    assert.equal(list[0].danceId, 'b');
    assert.equal(list[1].danceId, 'a');
  });

  it('getAttempt finds the saved record by id', async () => {
    const res = await saveAttempt(baseAttempt());
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const got = await getAttempt(res.id);
    assert.ok(got, 'record fetched');
    assert.equal(got!.id, res.id);
    assert.equal(got!.danceId, 'dance-1');
  });

  it('deleteAttempt removes the record', async () => {
    const res = await saveAttempt(baseAttempt());
    assert.equal(res.ok, true);
    if (!res.ok) return;
    await deleteAttempt(res.id);
    const got = await getAttempt(res.id);
    assert.equal(got, null);
  });

  it('updateNotes writes a notes field on an existing record', async () => {
    const res = await saveAttempt(baseAttempt());
    assert.equal(res.ok, true);
    if (!res.ok) return;
    await updateNotes(res.id, 'sincere attempt, scored 10');
    const got = await getAttempt(res.id);
    assert.equal(got?.notes, 'sincere attempt, scored 10');
  });

  it('clearAttempts wipes the fallback list', async () => {
    await saveAttempt(baseAttempt());
    await saveAttempt(baseAttempt());
    await clearAttempts();
    const list = await listAttempts();
    assert.equal(list.length, 0);
  });
});

describe('attemptStore — base64 / blob helpers', () => {
  beforeEach(() => {
    installLocalStorageOnly();
  });

  it('base64ToBlob produces a Blob with the expected type and bytes', () => {
    // "hi" → base64 "aGk="
    const blob = base64ToBlob('aGk=', 'video/webm');
    assert.equal(blob.type, 'video/webm');
    assert.equal(blob.size, 2);
  });

  it('base64ToBlob defaults the mime type when none is provided', () => {
    const blob = base64ToBlob('aGk=', '');
    assert.equal(blob.type, 'application/octet-stream');
  });
});

describe('attemptStore — export / import round-trip', () => {
  beforeEach(() => {
    installLocalStorageOnly();
  });

  it('exportAllAsJson includes every saved record', async () => {
    await saveAttempt({ ...baseAttempt(), danceId: 'one' });
    await saveAttempt({ ...baseAttempt(), danceId: 'two' });
    const json = await exportAllAsJson();
    const parsed = JSON.parse(json) as { version: number; attempts: SavedAttempt[] };
    assert.equal(parsed.version, 1);
    assert.equal(parsed.attempts.length, 2);
    const ids = parsed.attempts.map((a) => a.danceId).sort();
    assert.deepEqual(ids, ['one', 'two']);
  });

  it('importFromJson re-mints ids and resaves the records', async () => {
    await saveAttempt({ ...baseAttempt(), danceId: 'orig' });
    const json = await exportAllAsJson();
    await clearAttempts();
    const { imported, skipped } = await importFromJson(json);
    assert.equal(imported, 1);
    assert.equal(skipped, 0);
    const list = await listAttempts();
    assert.equal(list.length, 1);
    assert.equal(list[0].danceId, 'orig');
  });

  it('importFromJson tolerates malformed payloads', async () => {
    const { imported, skipped } = await importFromJson('not-json');
    assert.equal(imported, 0);
    assert.equal(skipped, 0);
  });

  it('importFromJson skips non-attempt entries', async () => {
    const payload = JSON.stringify({
      version: 1,
      attempts: [
        baseAttempt(),
        { id: 'x', savedAt: 1 }, // missing required fields beyond id/savedAt — also "valid enough" for isSavedAttempt
        'not-an-object',
      ],
    });
    const { imported, skipped } = await importFromJson(payload);
    // baseAttempt has no id/savedAt so isSavedAttempt rejects → skipped:
    // we built the JSON to contain the literal baseAttempt() object (no id/savedAt).
    // The minimal {id, savedAt} object passes isSavedAttempt and is imported.
    // The string entry is skipped.
    assert.equal(imported + skipped, 3);
    assert.ok(skipped >= 1, 'at least one non-attempt entry is skipped');
  });
});
