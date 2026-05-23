// POST /api/score-gemini — async grader for a finished Mode B attempt.
//
// Contract:
//   body: { referenceVideoBase64, attemptVideoBase64,
//           referenceMimeType?, attemptMimeType? }
//   ok:   { score: GeminiScore, latencyMs: number }
//   err:  { error: string }            (status 400 / 502)
//
// Uses INLINE base64 video (NOT the Files API — known reliability issues
// per SPECK §Hard rule 4). Structured output enforced via responseSchema.
//
// Payload-size note: Vercel API routes cap request bodies (~4.5MB Hobby,
// 5MB Pro). Two 15s 720p clips base64-encoded can hit that ceiling. If
// it bites: change the contract so the reference is passed as a URL the
// server fetches and only the attempt rides as base64. Don't pre-optimize
// — measure first.
//
// Retry + failure visibility (SPECK §generosity-rewrite): one retry on
// transient failure (network, timeout, 5xx, schema/parse). Skip retry if
// the remaining latency budget can't fit it. Do NOT retry 4xx — those mean
// our request is malformed and a retry won't fix it. Every failure logs a
// specific reason tag so we can see WHY Gemini fell back, instead of just
// silently rendering "FALLBACK SCORING" in the UI.

import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

import { buildGeminiPrompt } from '@/lib/scoring/gemini/prompt';
import {
  GeminiResponseJsonSchema,
  GeminiScoreSchema,
  type GeminiScore,
} from '@/lib/scoring/gemini/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Total latency budget for the route end-to-end. Matches the client's
// AbortController in lib/scoring/gemini/client.ts. If a first attempt
// already consumed most of it, skip the retry.
const TOTAL_BUDGET_MS = 30_000;
// Minimum remaining budget required to bother retrying. A retry that has
// less than this left will almost certainly time out, so we skip straight
// to fallback instead of burning the budget.
const MIN_RETRY_BUDGET_MS = 8_000;

interface RequestBody {
  referenceVideoBase64?: string;
  attemptVideoBase64?: string;
  referenceMimeType?: string;
  attemptMimeType?: string;
  // SPECK §windowing-fix: chunk windowing context for the prompt. The
  // reference is now a padded chunk (chunk window ± 500ms) rather than
  // the full routine; these two fields tell Gemini which interior
  // seconds of the reference are the actual choreography and which are
  // padding. legsVisible comes from MediaPipe pose analysis on the
  // client; when false, the prompt downweights legs.
  legsVisible?: boolean;
  referenceChunkStartSec?: number;
  referenceChunkEndSec?: number;
  // SPECK round-3 §Group-1: client trims + horizontally flips the reference
  // so left/right matches the front-camera-mirrored attempt. Fallback path
  // (no trim) sends false and the prompt switches back to the mirror-copy
  // safety clause.
  referenceMirrored?: boolean;
  // SPECK round-3 §Group-2: client detected the first frame of dance
  // movement and re-recorded each video starting at that frame. The two
  // onset values are the absolute seconds in the SOURCE videos where motion
  // started (diagnostic only). `videosMotionOnsetTrimmed` is the flag the
  // prompt branches on — true means both videos arrive starting at the
  // dance, no padding to ignore.
  referenceMotionOnsetSec?: number | null;
  attemptMotionOnsetSec?: number | null;
  videosMotionOnsetTrimmed?: boolean;
}

// Distinct failure reasons surfaced in logs and the response body so we can
// tell at a glance WHY we fell back without grepping stack traces. Order
// matters for diagnose-ability: 4xx is non-retryable, the rest are retryable.
type FailureReason =
  | 'timeout'
  | 'network'
  | 'schema_validation'
  | 'json_parse'
  | 'empty_response'
  | 'upstream_5xx'
  | 'upstream_4xx'
  | 'unknown';

interface AttemptSuccess {
  ok: true;
  score: GeminiScore;
  latencyMs: number;
}

interface AttemptFailure {
  ok: false;
  reason: FailureReason;
  message: string;
  // Non-retryable failures (4xx) tell the caller to skip the retry.
  retryable: boolean;
}

type AttemptResult = AttemptSuccess | AttemptFailure;

function classifyError(err: unknown): { reason: FailureReason; message: string; retryable: boolean } {
  const message = err instanceof Error ? err.message : String(err);
  // The @google/genai SDK throws errors whose message includes the HTTP
  // status when the upstream returns non-2xx. Pattern-match against the
  // common shapes so we can distinguish retryable transient errors from
  // 4xx "your request is broken" failures.
  if (err instanceof DOMException && err.name === 'AbortError') {
    return { reason: 'timeout', message, retryable: true };
  }
  if (/abort|timeout|timed out|ETIMEDOUT/i.test(message)) {
    return { reason: 'timeout', message, retryable: true };
  }
  // 5xx upstream — transient; retry.
  if (/\b5\d\d\b/.test(message) || /server error/i.test(message)) {
    return { reason: 'upstream_5xx', message, retryable: true };
  }
  // 4xx upstream — our request is malformed; do not retry.
  if (/\b4\d\d\b/.test(message) || /invalid argument|permission denied|unauthenticated/i.test(message)) {
    return { reason: 'upstream_4xx', message, retryable: false };
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|fetch failed|network/i.test(message)) {
    return { reason: 'network', message, retryable: true };
  }
  return { reason: 'unknown', message, retryable: true };
}

async function callGeminiOnce(args: {
  ai: GoogleGenAI;
  prompt: string;
  referenceVideoBase64: string;
  attemptVideoBase64: string;
  referenceMimeType: string;
  attemptMimeType: string;
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
            { text: 'REFERENCE:' },
            {
              inlineData: {
                mimeType: args.referenceMimeType,
                data: args.referenceVideoBase64,
              },
            },
            { text: 'ATTEMPT:' },
            {
              inlineData: {
                mimeType: args.attemptMimeType,
                data: args.attemptVideoBase64,
              },
            },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        responseSchema: GeminiResponseJsonSchema as any,
      },
    });

    const latencyMs = Date.now() - startTime;
    const text = response.text;
    console.log('[gemini-score] raw response text:', text);
    console.log('[gemini-score] latencyMs:', latencyMs);

    if (!text) {
      return { ok: false, reason: 'empty_response', message: 'Gemini returned empty response', retryable: true };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch (err) {
      return {
        ok: false,
        reason: 'json_parse',
        message: err instanceof Error ? err.message : String(err),
        retryable: true,
      };
    }

    const parsed = GeminiScoreSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return {
        ok: false,
        reason: 'schema_validation',
        message: JSON.stringify(parsed.error.flatten()),
        retryable: true,
      };
    }

    return { ok: true, score: parsed.data, latencyMs };
  } catch (err) {
    const { reason, message, retryable } = classifyError(err);
    return { ok: false, reason, message, retryable };
  }
}

export async function POST(req: NextRequest) {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const {
    referenceVideoBase64,
    attemptVideoBase64,
    referenceMimeType,
    attemptMimeType,
    legsVisible = true,
    referenceChunkStartSec = 0,
    referenceChunkEndSec,
    referenceMirrored = true,
    referenceMotionOnsetSec = null,
    attemptMotionOnsetSec = null,
    videosMotionOnsetTrimmed = false,
  } = body;

  console.log('[gemini-score] referenceVideoBase64 length:', referenceVideoBase64?.length ?? 'MISSING');
  console.log('[gemini-score] attemptVideoBase64 length:', attemptVideoBase64?.length ?? 'MISSING');
  console.log('[gemini-score] referenceMimeType:', referenceMimeType);
  console.log('[gemini-score] attemptMimeType:', attemptMimeType);
  console.log('[gemini-score] legsVisible:', legsVisible);
  console.log('[gemini-score] referenceChunkStartSec:', referenceChunkStartSec);
  console.log('[gemini-score] referenceChunkEndSec:', referenceChunkEndSec);
  console.log('[gemini-score] referenceMirrored:', referenceMirrored);
  console.log('[gemini-score] referenceMotionOnsetSec:', referenceMotionOnsetSec);
  console.log('[gemini-score] attemptMotionOnsetSec:', attemptMotionOnsetSec);
  console.log('[gemini-score] videosMotionOnsetTrimmed:', videosMotionOnsetTrimmed);

  if (!referenceVideoBase64 || !attemptVideoBase64) {
    return NextResponse.json(
      { error: 'Missing videos: need referenceVideoBase64 and attemptVideoBase64' },
      { status: 400 },
    );
  }

  // Derive the chunk-end seconds if the client didn't send one. We can't
  // know the reference duration here (the bytes are opaque base64), so
  // default to a 2s window from the chunk start — matches the typical
  // chunk size (1.5s) + padding. The client should always send this in
  // practice; the default is a fallback for older clients.
  const resolvedChunkEndSec =
    typeof referenceChunkEndSec === 'number' && referenceChunkEndSec > referenceChunkStartSec
      ? referenceChunkEndSec
      : referenceChunkStartSec + 2.0;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'GEMINI_API_KEY not configured' }, { status: 500 });
  }

  const ai = new GoogleGenAI({ apiKey });
  const routeStart = Date.now();

  const prompt = buildGeminiPrompt({
    legsVisible,
    referenceChunkStartSec,
    referenceChunkEndSec: resolvedChunkEndSec,
    referenceMirrored,
    videosMotionOnsetTrimmed,
  });

  const callArgs = {
    ai,
    prompt,
    referenceVideoBase64,
    attemptVideoBase64,
    referenceMimeType: referenceMimeType || 'video/mp4',
    attemptMimeType: attemptMimeType || 'video/mp4',
  };

  const first = await callGeminiOnce(callArgs);
  if (first.ok) {
    return NextResponse.json({ score: first.score, latencyMs: first.latencyMs });
  }

  console.error(`[gemini-score][failure] reason=${first.reason} attempt=1 message=${first.message}`);

  // Decide whether to retry. Skip if the failure isn't retryable, or if the
  // remaining latency budget can't fit another full attempt.
  const elapsed = Date.now() - routeStart;
  const remaining = TOTAL_BUDGET_MS - elapsed;
  if (!first.retryable) {
    console.error(`[gemini-score][fallback] reason=${first.reason} retried=false cause=non_retryable`);
    return NextResponse.json({ error: first.message, reason: first.reason }, { status: 502 });
  }
  if (remaining < MIN_RETRY_BUDGET_MS) {
    console.error(
      `[gemini-score][fallback] reason=${first.reason} retried=false cause=budget_exhausted remainingMs=${remaining}`,
    );
    return NextResponse.json({ error: first.message, reason: first.reason }, { status: 502 });
  }

  console.warn(`[gemini-score] retrying once (remainingBudgetMs=${remaining})`);
  const second = await callGeminiOnce(callArgs);
  if (second.ok) {
    console.log('[gemini-score] retry succeeded');
    return NextResponse.json({ score: second.score, latencyMs: second.latencyMs });
  }

  console.error(`[gemini-score][failure] reason=${second.reason} attempt=2 message=${second.message}`);
  console.error(
    `[gemini-score][fallback] reason=${second.reason} retried=true firstReason=${first.reason}`,
  );
  return NextResponse.json({ error: second.message, reason: second.reason }, { status: 502 });
}
