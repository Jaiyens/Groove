// POST /api/score-gemini-composite — Gemini grader for the side-by-side
// composite video variant (SPECK overnight Group 4).
//
// Contract:
//   body: { compositeVideoBase64, compositeMimeType?, legsVisible?, mirror? }
//   ok:   { score: GeminiScore, latencyMs: number }
//   err:  { error: string, reason?: string, __debug: {...} }    (status 502
//         on classified failures; status 200 on handler-level exception so
//         the browser network tab shows the __debug body without CORS or
//         error-handling getting in the way)
//
// Differs from /api/score-gemini in that the model receives ONE video
// (REF on the left half, ATTEMPT on the right half, audio-synced to
// reference). The prompt is buildCompositePrompt — same severity
// calibration, canary, tier-capped trouble spots, conditional-positive-
// insight invariants, with the framing clauses adapted for two-halves.
//
// Retry semantics, failure classification, and logging mirror the
// two-video route exactly so a future caller (and the field-log
// grep tooling) can treat them as a uniform Gemini scoring surface.

import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffmpeg from 'fluent-ffmpeg';

import { buildCompositePrompt } from '@/lib/scoring/gemini/prompt';
import {
  GeminiSpecResponseJsonSchema,
  GeminiSpecScoreSchema,
  type GeminiSpecScore,
} from '@/lib/scoring/gemini/types';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// SPEC: score-restoration §Change 1. Gemini's generateContent rejects
// video/webm with 400 INVALID_ARGUMENT; transcoding to MP4/H.264 yuv420p
// with audio stripped is the unlock. The @ffmpeg-installer binary ships
// with the deployment so we don't depend on a system ffmpeg.
async function transcodeWebmToMp4(
  webmBase64: string,
): Promise<{ mp4Base64: string; mp4Bytes: number; elapsedMs: number }> {
  const start = Date.now();
  const tmpDir = os.tmpdir();
  const id = crypto.randomUUID();
  const webmPath = path.join(tmpDir, `${id}.webm`);
  const mp4Path = path.join(tmpDir, `${id}.mp4`);
  const webmBuf = Buffer.from(webmBase64, 'base64');
  await fs.writeFile(webmPath, webmBuf);
  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(webmPath)
        .videoCodec('libx264')
        .outputOptions([
          '-pix_fmt yuv420p',
          '-an',
          '-preset ultrafast',
          '-movflags +faststart',
        ])
        .save(mp4Path)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err));
    });
    const mp4Buf = await fs.readFile(mp4Path);
    return {
      mp4Base64: mp4Buf.toString('base64'),
      mp4Bytes: mp4Buf.length,
      elapsedMs: Date.now() - start,
    };
  } finally {
    await Promise.allSettled([fs.unlink(webmPath), fs.unlink(mp4Path)]);
  }
}

export const runtime = 'nodejs';
// maxDuration must exceed the client's 90s timeout so the route doesn't get
// killed mid-flight. Vercel hard-caps this at 60s on Hobby and 300s on Pro;
// 120s lets us cover the 80s server budget + retry headroom on Pro and the
// hard cap on Hobby.
export const maxDuration = 120;

// Server-side total budget. Client now waits 90s (SPEC §score-restoration
// non-negotiable: at least 90000ms). Server budget sits just under client
// timeout to leave room for response transport. First attempt + retry must
// both fit within this.
const TOTAL_BUDGET_MS = 80_000;
const MIN_RETRY_BUDGET_MS = 20_000;

interface RequestBody {
  compositeVideoBase64?: string;
  compositeMimeType?: string;
  legsVisible?: boolean;
  // Whether the composite renderer mirrored the LEFT half. The prompt
  // flips its left/right correspondence clause based on this. SPECK
  // overnight Group 4 + Group 2 §mirror-unification.
  mirror?: boolean;
  // SPEC: score-restoration §c. The user's first frame of real dance
  // movement in the COMPOSITE's right-half timebase. The composite is
  // typically pre-trimmed so this is 0.00s, but the prompt still surfaces
  // it verbatim per the spec.
  motionOnsetSec?: number;
}

type FailureReason =
  | 'timeout'
  | 'network'
  | 'schema_validation'
  | 'json_parse'
  | 'empty_response'
  | 'upstream_5xx'
  | 'upstream_4xx'
  | 'unknown';

// Captured raw signature of whatever the SDK / inner flow surfaced. Surfaces
// into the response body __debug field so the browser network tab can show
// it without us needing terminal logs.
interface RawErrorSignature {
  errorMessage: string;
  errorStatus?: number;
  errorName?: string;
  errorBody?: unknown;
}

interface AttemptSuccess {
  ok: true;
  score: GeminiSpecScore;
  latencyMs: number;
}
interface AttemptFailure {
  ok: false;
  reason: FailureReason;
  message: string;
  retryable: boolean;
  raw: RawErrorSignature;
}
type AttemptResult = AttemptSuccess | AttemptFailure;

interface GeminiRequestPreview {
  promptLength: number | null;
  schemaJson: unknown;
  motionOnsetSec: number | null;
  compositeBytes: number | null;
}

function emptyPreview(): GeminiRequestPreview {
  return { promptLength: null, schemaJson: null, motionOnsetSec: null, compositeBytes: null };
}

// Pull as much signature as we can from a thrown value. The Gemini SDK error
// surface is undocumented; read defensively through `any` and try to surface
// the upstream response body specifically since that's what carries the real
// 4xx/5xx reason.
function extractRawSignature(err: unknown): RawErrorSignature {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any;
  const sig: RawErrorSignature = {
    errorMessage: err instanceof Error ? err.message : String(err),
  };
  if (e?.name !== undefined) sig.errorName = String(e.name);
  if (e?.status !== undefined && typeof e.status === 'number') sig.errorStatus = e.status;
  // The SDK sometimes stores the upstream body on .response, sometimes on
  // .response.data, sometimes only on .cause. Try each. Prefer parsed JSON.
  const candidates: unknown[] = [];
  if (e?.response !== undefined) candidates.push(e.response);
  if (e?.cause !== undefined) candidates.push(e.cause);
  // Also try the message itself — the SDK frequently embeds the upstream
  // JSON body as a string in the .message field, e.g.
  //   "got status: 400 Bad Request. {\"error\":{\"code\":400,...}}"
  // Surface it verbatim so the browser can read it.
  if (typeof e?.message === 'string') candidates.push(e.message);
  for (const c of candidates) {
    if (c === undefined || c === null) continue;
    if (typeof c === 'string') {
      // Try to find an embedded JSON object and parse it.
      const idx = c.indexOf('{');
      if (idx >= 0) {
        try {
          sig.errorBody = JSON.parse(c.slice(idx));
          break;
        } catch {
          // fall through and store raw string
        }
      }
      sig.errorBody = c;
      break;
    }
    // Object — keep as-is; NextResponse.json will serialize it.
    sig.errorBody = c;
    break;
  }
  return sig;
}

function classifyError(err: unknown): { reason: FailureReason; message: string; retryable: boolean } {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof DOMException && err.name === 'AbortError') {
    return { reason: 'timeout', message, retryable: true };
  }
  if (/abort|timeout|timed out|ETIMEDOUT/i.test(message)) {
    return { reason: 'timeout', message, retryable: true };
  }
  if (/\b5\d\d\b/.test(message) || /server error/i.test(message)) {
    return { reason: 'upstream_5xx', message, retryable: true };
  }
  if (/\b4\d\d\b/.test(message) || /invalid argument|permission denied|unauthenticated/i.test(message)) {
    return { reason: 'upstream_4xx', message, retryable: false };
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|fetch failed|network/i.test(message)) {
    return { reason: 'network', message, retryable: true };
  }
  return { reason: 'unknown', message, retryable: true };
}

// Surface every field a Gemini SDK error might carry so a field log line
// includes BOTH the human message and any upstream HTTP status / body. The
// SDK's error class shape is not documented as stable, so we read defensively
// through `any` and serialize whatever's there.
function logRawSdkError(label: string, err: unknown): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any;
  // eslint-disable-next-line no-console
  console.error(`[composite-route-error] ${label}: typeof=${typeof err} constructor=${err?.constructor?.name ?? '<none>'}`);
  // eslint-disable-next-line no-console
  console.error(`[composite-route-error] ${label}: message=${e?.message ?? '<none>'}`);
  // eslint-disable-next-line no-console
  console.error(`[composite-route-error] ${label}: stack=${e?.stack ?? '<none>'}`);
  // SDK-specific fields when present. None of these are guaranteed.
  if (e?.status !== undefined) console.error(`[composite-route-error] ${label}: status=${e.status}`);
  if (e?.statusText !== undefined) console.error(`[composite-route-error] ${label}: statusText=${e.statusText}`);
  if (e?.code !== undefined) console.error(`[composite-route-error] ${label}: code=${e.code}`);
  if (e?.name !== undefined) console.error(`[composite-route-error] ${label}: name=${e.name}`);
  if (e?.response !== undefined) {
    try {
      // eslint-disable-next-line no-console
      console.error(`[composite-route-error] ${label}: response=${JSON.stringify(e.response, null, 2)}`);
    } catch {
      // eslint-disable-next-line no-console
      console.error(`[composite-route-error] ${label}: response=<unserializable>`);
    }
  }
  if (e?.cause !== undefined) {
    try {
      // eslint-disable-next-line no-console
      console.error(`[composite-route-error] ${label}: cause=${JSON.stringify(e.cause, null, 2)}`);
    } catch {
      // eslint-disable-next-line no-console
      console.error(`[composite-route-error] ${label}: cause=${String(e.cause)}`);
    }
  }
  // Last resort: dump enumerable own-properties so an unknown SDK field still
  // shows up. JSON.stringify on Error instances skips message/stack, so this
  // is additive to the explicit lines above.
  try {
    const own = Object.getOwnPropertyNames(e ?? {}).filter(
      (k) => !['message', 'stack', 'response', 'cause'].includes(k),
    );
    if (own.length > 0) {
      const dump: Record<string, unknown> = {};
      for (const k of own) dump[k] = e[k];
      // eslint-disable-next-line no-console
      console.error(`[composite-route-error] ${label}: ownProps=${JSON.stringify(dump, null, 2)}`);
    }
  } catch {
    // ignore
  }
}

async function callGeminiOnce(args: {
  ai: GoogleGenAI;
  prompt: string;
  compositeVideoBase64: string;
  compositeMimeType: string;
  attemptLabel: string;
}): Promise<AttemptResult> {
  const startTime = Date.now();
  try {
    const response = await args.ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            { text: args.prompt },
            { text: 'SIDE-BY-SIDE VIDEO:' },
            {
              inlineData: {
                mimeType: args.compositeMimeType,
                data: args.compositeVideoBase64,
              },
            },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        responseSchema: GeminiSpecResponseJsonSchema as any,
      },
    });
    const latencyMs = Date.now() - startTime;
    const text = response.text;
    // eslint-disable-next-line no-console
    console.log(`[composite-route-response] ${args.attemptLabel}: raw text=`, text);
    // Dump the full response object too — promptFeedback / safetyRatings /
    // finishReason live on it and are how we'd see a content-filter trip
    // (Gemini can return a 200 with empty text when safety blocks fire).
    try {
      // eslint-disable-next-line no-console
      console.log(`[composite-route-response] ${args.attemptLabel}: full=`, JSON.stringify(response, null, 2));
    } catch {
      // eslint-disable-next-line no-console
      console.log(`[composite-route-response] ${args.attemptLabel}: full=<unserializable>`);
    }
    // eslint-disable-next-line no-console
    console.log(`[composite-route-response] ${args.attemptLabel}: latencyMs=${latencyMs}`);

    if (!text) {
      return {
        ok: false,
        reason: 'empty_response',
        message: 'Gemini returned empty response',
        retryable: true,
        raw: { errorMessage: 'Gemini returned empty response', errorBody: response as unknown },
      };
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[composite-route-error] ${args.attemptLabel}: JSON.parse threw on Gemini text`);
      logRawSdkError(args.attemptLabel, err);
      return {
        ok: false,
        reason: 'json_parse',
        message: err instanceof Error ? err.message : String(err),
        retryable: true,
        raw: { ...extractRawSignature(err), errorBody: text },
      };
    }
    const parsed = GeminiSpecScoreSchema.safeParse(parsedJson);
    if (!parsed.success) {
      // eslint-disable-next-line no-console
      console.error(`[composite-route-error] ${args.attemptLabel}: spec schema rejected response`);
      // eslint-disable-next-line no-console
      console.error(`[composite-route-error] ${args.attemptLabel}: schema errors=`, JSON.stringify(parsed.error.flatten(), null, 2));
      return {
        ok: false,
        reason: 'schema_validation',
        message: JSON.stringify(parsed.error.flatten()),
        retryable: true,
        raw: {
          errorMessage: 'Spec schema rejected Gemini response',
          errorName: 'ZodSchemaValidationError',
          errorBody: { schemaErrors: parsed.error.flatten(), geminiBody: parsedJson },
        },
      };
    }
    return { ok: true, score: parsed.data, latencyMs };
  } catch (err) {
    // Log everything we can extract BEFORE classification so the field log
    // shows the raw upstream signature even when classifyError buckets it
    // into a vague reason like 'unknown' or 'upstream_5xx'.
    const elapsedMs = Date.now() - startTime;
    // eslint-disable-next-line no-console
    console.error(`[composite-route-error] ${args.attemptLabel}: Gemini SDK call threw after ${elapsedMs}ms`);
    logRawSdkError(args.attemptLabel, err);
    const { reason, message, retryable } = classifyError(err);
    // eslint-disable-next-line no-console
    console.error(`[composite-route-error] ${args.attemptLabel}: classified reason=${reason} retryable=${retryable}`);
    return { ok: false, reason, message, retryable, raw: extractRawSignature(err) };
  }
}

export async function POST(req: NextRequest) {
  // Diagnostic-mode top-level try/catch: ANY uncaught throw lands in the
  // outer catch and returns 200 with a __debug body. We deliberately return
  // 200 (not 500) so Chrome DevTools shows the response body without CORS
  // or default error UI getting in the way. The classified-failure return
  // paths below still use 502 (the contract), but every non-happy-path
  // return — 400 / 502 / outer-catch — includes a top-level __debug field.
  //
  // The preview/raw fields here let us reconstruct what was sent and what
  // came back without scraping terminal logs.
  let preview: GeminiRequestPreview = emptyPreview();
  try {
    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[composite-route-error] request body JSON.parse failed');
      logRawSdkError('request-body', err);
      return NextResponse.json(
        {
          __debug: {
            ...extractRawSignature(err),
            geminiRequestPreview: preview,
          },
          error: 'Invalid JSON body',
        },
        { status: 400 },
      );
    }

    const {
      compositeVideoBase64,
      compositeMimeType,
      legsVisible = true,
      mirror = true,
      motionOnsetSec = 0,
    } = body;

    // Per spec: log the inputs BEFORE the Gemini call so a hung/erroring
    // call still leaves a trail of what was sent. Prefix [composite-route-
    // input] groups them in `grep` together with the prompt + schema logs
    // below.
    // eslint-disable-next-line no-console
    console.log('[composite-route-input] compositeVideoBase64 length:', compositeVideoBase64?.length ?? 'MISSING');
    // eslint-disable-next-line no-console
    console.log('[composite-route-input] compositeMimeType:', compositeMimeType);
    // eslint-disable-next-line no-console
    console.log('[composite-route-input] legsVisible:', legsVisible);
    // eslint-disable-next-line no-console
    console.log('[composite-route-input] mirror:', mirror);
    // eslint-disable-next-line no-console
    console.log('[composite-route-input] motionOnsetSec:', motionOnsetSec);

    // Stash what we know so far so any subsequent failure can surface it.
    preview = {
      promptLength: null,
      schemaJson: GeminiSpecResponseJsonSchema,
      motionOnsetSec,
      compositeBytes: compositeVideoBase64?.length ?? null,
    };

    if (!compositeVideoBase64) {
      // eslint-disable-next-line no-console
      console.error('[composite-route-error] missing compositeVideoBase64 in request body');
      return NextResponse.json(
        {
          __debug: {
            errorMessage: 'Missing video: need compositeVideoBase64',
            errorName: 'BadRequest',
            geminiRequestPreview: preview,
          },
          error: 'Missing video: need compositeVideoBase64',
        },
        { status: 400 },
      );
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      // eslint-disable-next-line no-console
      console.error('[composite-route-error] GEMINI_API_KEY env var not configured');
      return NextResponse.json(
        {
          __debug: {
            errorMessage: 'GEMINI_API_KEY not configured',
            errorName: 'MissingEnv',
            geminiRequestPreview: preview,
          },
          error: 'GEMINI_API_KEY not configured',
        },
        { status: 500 },
      );
    }

    // SPEC: score-restoration §Change 1. Transcode WebM to MP4/H.264 before
    // calling Gemini — the standard generateContent API rejects video/webm.
    // Skip the transcode if the inbound video is already MP4-compatible
    // (future-proofing for when composite.ts may output MP4 natively).
    let videoBase64 = compositeVideoBase64;
    let videoMimeType = compositeMimeType || 'video/webm';
    if (videoMimeType.startsWith('video/webm')) {
      // eslint-disable-next-line no-console
      console.log(
        `[composite-route-transcode] start mime=${videoMimeType} bytes=${videoBase64.length}`,
      );
      try {
        const transcoded = await transcodeWebmToMp4(videoBase64);
        videoBase64 = transcoded.mp4Base64;
        videoMimeType = 'video/mp4';
        // eslint-disable-next-line no-console
        console.log(
          `[composite-route-transcode] done newBytes=${transcoded.mp4Bytes} elapsedMs=${transcoded.elapsedMs}`,
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[composite-route-error] webm to mp4 transcode failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        logRawSdkError('transcode', err);
        return NextResponse.json(
          {
            __debug: {
              ...extractRawSignature(err),
              errorMessage: `webm to mp4 transcode failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
              geminiRequestPreview: preview,
            },
            error: 'webm to mp4 transcode failed',
            reason: 'transcode_failed',
          },
          { status: 502 },
        );
      }
    }

    const ai = new GoogleGenAI({ apiKey });
    const routeStart = Date.now();

    // SPEC: score-restoration §Change 2. motionOnsetSec is no longer used
    // by the prompt — the composite is pre-trimmed on both halves. The
    // request body still accepts the field for backwards-compat but it's
    // ignored downstream.
    const prompt = buildCompositePrompt({ legsVisible, mirror });
    preview = {
      promptLength: prompt.length,
      schemaJson: GeminiSpecResponseJsonSchema,
      motionOnsetSec,
      compositeBytes: videoBase64.length,
    };
    // eslint-disable-next-line no-console
    console.log('[composite-route-prompt]', prompt);
    // eslint-disable-next-line no-console
    console.log('[composite-route-schema]', JSON.stringify(GeminiSpecResponseJsonSchema, null, 2));

    const callArgs = {
      ai,
      prompt,
      compositeVideoBase64: videoBase64,
      compositeMimeType: videoMimeType,
    };

    const first = await callGeminiOnce({ ...callArgs, attemptLabel: 'attempt=1' });
    if (first.ok) {
      return NextResponse.json({ score: first.score, latencyMs: first.latencyMs });
    }

    // eslint-disable-next-line no-console
    console.error(`[composite-route-failure] reason=${first.reason} attempt=1 message=${first.message}`);
    const elapsed = Date.now() - routeStart;
    const remaining = TOTAL_BUDGET_MS - elapsed;
    if (!first.retryable) {
      // eslint-disable-next-line no-console
      console.error(`[composite-route-fallback] reason=${first.reason} retried=false cause=non_retryable`);
      return NextResponse.json(
        {
          __debug: { ...first.raw, geminiRequestPreview: preview },
          error: first.message,
          reason: first.reason,
        },
        { status: 502 },
      );
    }
    if (remaining < MIN_RETRY_BUDGET_MS) {
      // eslint-disable-next-line no-console
      console.error(
        `[composite-route-fallback] reason=${first.reason} retried=false cause=budget_exhausted remainingMs=${remaining}`,
      );
      return NextResponse.json(
        {
          __debug: { ...first.raw, geminiRequestPreview: preview },
          error: first.message,
          reason: first.reason,
        },
        { status: 502 },
      );
    }

    // eslint-disable-next-line no-console
    console.warn(`[composite-route] retrying once (remainingBudgetMs=${remaining})`);
    const second = await callGeminiOnce({ ...callArgs, attemptLabel: 'attempt=2' });
    if (second.ok) {
      // eslint-disable-next-line no-console
      console.log('[composite-route] retry succeeded');
      return NextResponse.json({ score: second.score, latencyMs: second.latencyMs });
    }
    // eslint-disable-next-line no-console
    console.error(`[composite-route-failure] reason=${second.reason} attempt=2 message=${second.message}`);
    // eslint-disable-next-line no-console
    console.error(
      `[composite-route-fallback] reason=${second.reason} retried=true firstReason=${first.reason}`,
    );
    return NextResponse.json(
      {
        __debug: {
          ...second.raw,
          firstAttemptRaw: first.raw,
          firstAttemptReason: first.reason,
          geminiRequestPreview: preview,
        },
        error: second.message,
        reason: second.reason,
      },
      { status: 502 },
    );
  } catch (err) {
    // Anything that escaped the inner flow lands here. Return 200 with the
    // __debug body so Chrome DevTools Network → Response shows it directly
    // (no CORS / default-error-UI fighting us). The terminal logs still
    // fire below as a backup.
    // eslint-disable-next-line no-console
    console.error('[composite-route-error] handler-level exception escaped');
    logRawSdkError('handler', err);
    return NextResponse.json(
      {
        __debug: {
          ...extractRawSignature(err),
          handlerLevel: true,
          geminiRequestPreview: preview,
        },
        error: err instanceof Error ? err.message : String(err),
        reason: 'handler_exception',
      },
      { status: 200 },
    );
  }
}
