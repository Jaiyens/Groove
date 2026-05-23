// SPECK overnight Track 2 — capture store for scoring debug surface.
//
// Persists every Gemini scoring attempt (when the capture toggle is on) so
// the user can replay them on `/debug/scoring` without re-recording. Backed
// by IndexedDB (`groov-debug` / `attempts`); falls back to localStorage when
// IDB is unavailable (private browsing, locked-down browsers).
//
// Fire-and-forget: every API surface here either resolves with the result
// or resolves with an error-shaped result. They never throw — the caller in
// scoring/gemini/client.ts wraps these in try/catch anyway so a logging
// failure can never break the user-facing score.

export type DurationSource =
  | 'webm-repair-inferred'
  | 'browser-finalize'
  | 'server-repair'
  | null;

export type SavedAttempt = {
  id: string;
  savedAt: number;
  danceId: string;
  chunkIndex: number;
  referenceUrl: string;
  attemptBlobBase64: string;
  attemptMimeType: string;
  chunkStartMs: number;
  chunkEndMs: number;
  motionOnsetRefSec: number | null;
  motionOnsetAttemptSec: number | null;
  mirror: boolean;
  legsVisible: boolean;
  requestPayload: unknown;
  responseRaw: unknown;
  responseDeterministic: unknown;
  latencyMs: number;
  durationSource: DurationSource;
  authoritativeDurationSec: number;
  notes?: string;
};

export const CAPTURE_FLAG_KEY = 'groov_debug_capture';
export const LOCALSTORAGE_FALLBACK_KEY = 'groov_debug_attempts_fallback';

const DB_NAME = 'groov-debug';
const DB_VERSION = 1;
const STORE = 'attempts';

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

export function isCaptureEnabled(): boolean {
  if (!hasWindow()) return false;
  try {
    return window.localStorage.getItem(CAPTURE_FLAG_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setCaptureEnabled(on: boolean): void {
  if (!hasWindow()) return;
  try {
    if (on) window.localStorage.setItem(CAPTURE_FLAG_KEY, 'true');
    else window.localStorage.removeItem(CAPTURE_FLAG_KEY);
  } catch {
    // ignore quota / disabled storage
  }
}

function genId(): string {
  // Time-prefixed so listAttempts can sort newest-first by lexical id.
  // The random suffix keeps fast-fire saves (re-score in the eval harness)
  // from colliding inside the same ms.
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}_${rand}`;
}

type IdbHandle = IDBDatabase;

function openDb(): Promise<IdbHandle> {
  return new Promise<IdbHandle>((resolve, reject) => {
    if (!hasWindow() || typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IDB open failed'));
    req.onblocked = () => reject(new Error('IDB open blocked'));
  });
}

function txStore(db: IdbHandle, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

async function withDb<T>(fn: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  const db = await openDb();
  try {
    return await fn(txStore(db, 'readwrite'));
  } finally {
    db.close();
  }
}

function readWithLocalStorage(): SavedAttempt[] {
  if (!hasWindow()) return [];
  try {
    const raw = window.localStorage.getItem(LOCALSTORAGE_FALLBACK_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is SavedAttempt => isSavedAttempt(x));
  } catch {
    return [];
  }
}

function writeWithLocalStorage(attempts: SavedAttempt[]): { ok: boolean; reason?: string } {
  if (!hasWindow()) return { ok: false, reason: 'no-window' };
  try {
    window.localStorage.setItem(LOCALSTORAGE_FALLBACK_KEY, JSON.stringify(attempts));
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'unknown' };
  }
}

function isSavedAttempt(v: unknown): v is SavedAttempt {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.savedAt === 'number';
}

export type SaveResult =
  | { ok: true; id: string; backend: 'indexeddb' | 'localstorage' }
  | { ok: false; reason: string };

export async function saveAttempt(
  attempt: Omit<SavedAttempt, 'id' | 'savedAt'>,
): Promise<SaveResult> {
  const id = genId();
  const record: SavedAttempt = { ...attempt, id, savedAt: Date.now() };
  try {
    await withDb(async (store) => {
      await idbReq(store.put(record));
    });
    return { ok: true, id, backend: 'indexeddb' };
  } catch (idbErr) {
    const list = readWithLocalStorage();
    list.unshift(record);
    const w = writeWithLocalStorage(list);
    if (w.ok) return { ok: true, id, backend: 'localstorage' };
    return {
      ok: false,
      reason: `idb=${idbErr instanceof Error ? idbErr.message : 'unknown'}; ls=${w.reason ?? 'unknown'}`,
    };
  }
}

export async function listAttempts(): Promise<SavedAttempt[]> {
  try {
    return await withDb(async (store) => {
      const all = await idbReq<SavedAttempt[]>(store.getAll() as IDBRequest<SavedAttempt[]>);
      return all.sort((a, b) => b.savedAt - a.savedAt);
    });
  } catch {
    return readWithLocalStorage().sort((a, b) => b.savedAt - a.savedAt);
  }
}

export async function getAttempt(id: string): Promise<SavedAttempt | null> {
  try {
    return await withDb(async (store) => {
      const got = await idbReq<SavedAttempt | undefined>(
        store.get(id) as IDBRequest<SavedAttempt | undefined>,
      );
      return got ?? null;
    });
  } catch {
    return readWithLocalStorage().find((a) => a.id === id) ?? null;
  }
}

export async function deleteAttempt(id: string): Promise<void> {
  try {
    await withDb(async (store) => {
      await idbReq(store.delete(id));
    });
  } catch {
    const filtered = readWithLocalStorage().filter((a) => a.id !== id);
    writeWithLocalStorage(filtered);
  }
}

export async function clearAttempts(): Promise<void> {
  try {
    await withDb(async (store) => {
      await idbReq(store.clear());
    });
  } catch {
    writeWithLocalStorage([]);
  }
}

export async function updateNotes(id: string, notes: string): Promise<void> {
  try {
    await withDb(async (store) => {
      const existing = await idbReq<SavedAttempt | undefined>(
        store.get(id) as IDBRequest<SavedAttempt | undefined>,
      );
      if (!existing) return;
      const updated: SavedAttempt = { ...existing, notes };
      await idbReq(store.put(updated));
    });
  } catch {
    const list = readWithLocalStorage();
    const idx = list.findIndex((a) => a.id === id);
    if (idx >= 0) {
      list[idx] = { ...list[idx], notes };
      writeWithLocalStorage(list);
    }
  }
}

function idbReq<T = unknown>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IDB request failed'));
  });
}

// Convert a Blob to a base64 string (no data: prefix). Mirrors the helper
// used inside the gemini client — replicated here so this module has zero
// dependency on the scoring tree.
export function blobToBase64Safe(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (typeof FileReader === 'undefined') {
      reject(new Error('FileReader unavailable'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('FileReader returned non-string'));
        return;
      }
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
    reader.readAsDataURL(blob);
  });
}

// Convert a base64 string back into a Blob with the given MIME type. Used
// by the debug page when reconstructing a saved attempt for playback.
export function base64ToBlob(base64: string, mimeType: string): Blob {
  if (typeof atob !== 'function') {
    throw new Error('atob unavailable');
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType || 'application/octet-stream' });
}

// Export the full set as a JSON-encoded string. Used by the "Export all"
// button on the debug page. Blobs are stored already-base64 so the JSON
// is portable across machines / browsers without further encoding.
export async function exportAllAsJson(): Promise<string> {
  const attempts = await listAttempts();
  return JSON.stringify({ version: 1, attempts }, null, 2);
}

// Import a payload produced by exportAllAsJson. New ids are minted on
// import so re-importing the same export on a machine that already has
// the originals does not clobber them.
export async function importFromJson(json: string): Promise<{ imported: number; skipped: number }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { imported: 0, skipped: 0 };
  }
  if (typeof parsed !== 'object' || parsed === null) return { imported: 0, skipped: 0 };
  const arr = (parsed as { attempts?: unknown[] }).attempts;
  if (!Array.isArray(arr)) return { imported: 0, skipped: 0 };

  let imported = 0;
  let skipped = 0;
  for (const candidate of arr) {
    if (!isSavedAttempt(candidate)) {
      skipped += 1;
      continue;
    }
    // Strip the imported id + timestamp; saveAttempt re-mints.
    const { id: _id, savedAt: _savedAt, ...rest } = candidate;
    void _id;
    void _savedAt;
    const res = await saveAttempt(rest);
    if (res.ok) imported += 1;
    else skipped += 1;
  }
  return { imported, skipped };
}
