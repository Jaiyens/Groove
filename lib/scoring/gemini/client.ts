// Browser client for /api/score-gemini.
//
// Takes the attempt Blob (MediaRecorder output) + the reference video URL,
// base64-encodes both, POSTs to the serverless endpoint, validates the
// response with Zod, and returns a tagged union. Never throws.
//
// Timeout: 30s (SPECK §Hard rule 7) — past that, callers should treat it
// as a Gemini failure and fall back to MediaPipe silently. We DON'T retry
// — Gemini latency is the same order of magnitude as the retry budget, and
// a failed call is more likely a malformed video than a transient network.
//
// Payload-size note: see route.ts. Two 15s 720p base64-encoded clips can
// approach the Vercel body cap. If real measurements hit it, change the
// contract so the reference rides as a URL the server fetches. Don't
// pre-optimize.

import { GeminiScoreSchema, type GeminiScore } from './types';

export type GeminiResult =
  | { kind: 'success'; score: GeminiScore; latencyMs: number }
  | { kind: 'error'; reason: string };

const DEFAULT_TIMEOUT_MS = 30_000;

async function blobToBase64(blob: Blob): Promise<string> {
  // FileReader gives us a data URL; strip the `data:...;base64,` prefix.
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('FileReader returned non-string result'));
        return;
      }
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
    reader.readAsDataURL(blob);
  });
}

async function fetchReferenceAsBlob(url: string, signal?: AbortSignal): Promise<Blob> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`reference fetch failed: ${res.status}`);
  return res.blob();
}

export async function scoreWithGemini(
  attemptBlob: Blob,
  referenceVideoUrl: string,
  signal?: AbortSignal,
): Promise<GeminiResult> {
  const controller = new AbortController();
  const composedSignal = signal
    ? mergeSignals(signal, controller.signal)
    : controller.signal;
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const referenceBlob = await fetchReferenceAsBlob(referenceVideoUrl, composedSignal);
    const [attemptBase64, referenceBase64] = await Promise.all([
      blobToBase64(attemptBlob),
      blobToBase64(referenceBlob),
    ]);

    const res = await fetch('/api/score-gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: composedSignal,
      body: JSON.stringify({
        referenceVideoBase64: referenceBase64,
        attemptVideoBase64: attemptBase64,
        referenceMimeType: referenceBlob.type || 'video/mp4',
        attemptMimeType: attemptBlob.type || 'video/webm',
      }),
    });

    if (!res.ok) {
      let detail = '';
      try {
        const errJson = (await res.json()) as { error?: string };
        detail = errJson.error ? `: ${errJson.error}` : '';
      } catch {
        // body wasn't JSON, drop it
      }
      return { kind: 'error', reason: `gemini api ${res.status}${detail}` };
    }

    const json = (await res.json()) as { score?: unknown; latencyMs?: unknown };
    const parsed = GeminiScoreSchema.safeParse(json.score);
    if (!parsed.success) {
      return { kind: 'error', reason: 'response failed schema validation' };
    }
    const latencyMs = typeof json.latencyMs === 'number' ? json.latencyMs : 0;
    return { kind: 'success', score: parsed.data, latencyMs };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      // Was it our internal timeout or a caller cancel?
      if (signal?.aborted) return { kind: 'error', reason: 'cancelled' };
      return { kind: 'error', reason: 'timeout' };
    }
    return {
      kind: 'error',
      reason: err instanceof Error ? err.message : 'unknown error',
    };
  } finally {
    clearTimeout(timeout);
  }
}

function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (a.aborted) ctrl.abort();
  else a.addEventListener('abort', onAbort, { once: true });
  if (b.aborted) ctrl.abort();
  else b.addEventListener('abort', onAbort, { once: true });
  return ctrl.signal;
}
