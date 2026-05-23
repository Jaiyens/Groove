// POST /api/score-gemini-composite — Gemini grader for the side-by-side
// composite video variant (SPECK overnight Group 4).
//
// Contract:
//   body: { compositeVideoBase64, compositeMimeType?, legsVisible?, mirror? }
//   ok:   { score: GeminiScore, latencyMs: number }
//   err:  { error: string, reason?: string }            (status 400 / 502)
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

import { buildCompositePrompt } from '@/lib/scoring/gemini/prompt';
import {
  GeminiResponseJsonSchema,
  GeminiScoreSchema,
  type GeminiScore,
} from '@/lib/scoring/gemini/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

const TOTAL_BUDGET_MS = 30_000;
const MIN_RETRY_BUDGET_MS = 8_000;

interface RequestBody {
  compositeVideoBase64?: string;
  compositeMimeType?: string;
  legsVisible?: boolean;
  // Whether the composite renderer mirrored the LEFT half. The prompt
  // flips its left/right correspondence clause based on this. SPECK
  // overnight Group 4 + Group 2 §mirror-unification.
  mirror?: boolean;
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

interface AttemptSuccess {
  ok: true;
  score: GeminiScore;
  latencyMs: number;
}
interface AttemptFailure {
  ok: false;
  reason: FailureReason;
  message: string;
  retryable: boolean;
}
type AttemptResult = AttemptSuccess | AttemptFailure;

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

async function callGeminiOnce(args: {
  ai: GoogleGenAI;
  prompt: string;
  compositeVideoBase64: string;
  compositeMimeType: string;
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
        responseSchema: GeminiResponseJsonSchema as any,
      },
    });
    const latencyMs = Date.now() - startTime;
    const text = response.text;
    console.log('[gemini-score-composite] raw response text:', text);
    console.log('[gemini-score-composite] latencyMs:', latencyMs);

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
    compositeVideoBase64,
    compositeMimeType,
    legsVisible = true,
    mirror = true,
  } = body;

  console.log('[gemini-score-composite] compositeVideoBase64 length:', compositeVideoBase64?.length ?? 'MISSING');
  console.log('[gemini-score-composite] compositeMimeType:', compositeMimeType);
  console.log('[gemini-score-composite] legsVisible:', legsVisible);
  console.log('[gemini-score-composite] mirror:', mirror);

  if (!compositeVideoBase64) {
    return NextResponse.json(
      { error: 'Missing video: need compositeVideoBase64' },
      { status: 400 },
    );
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'GEMINI_API_KEY not configured' }, { status: 500 });
  }

  const ai = new GoogleGenAI({ apiKey });
  const routeStart = Date.now();

  const prompt = buildCompositePrompt({ legsVisible, mirror });

  const callArgs = {
    ai,
    prompt,
    compositeVideoBase64,
    compositeMimeType: compositeMimeType || 'video/webm',
  };

  const first = await callGeminiOnce(callArgs);
  if (first.ok) {
    return NextResponse.json({ score: first.score, latencyMs: first.latencyMs });
  }

  console.error(`[gemini-score-composite][failure] reason=${first.reason} attempt=1 message=${first.message}`);
  const elapsed = Date.now() - routeStart;
  const remaining = TOTAL_BUDGET_MS - elapsed;
  if (!first.retryable) {
    console.error(`[gemini-score-composite][fallback] reason=${first.reason} retried=false cause=non_retryable`);
    return NextResponse.json({ error: first.message, reason: first.reason }, { status: 502 });
  }
  if (remaining < MIN_RETRY_BUDGET_MS) {
    console.error(
      `[gemini-score-composite][fallback] reason=${first.reason} retried=false cause=budget_exhausted remainingMs=${remaining}`,
    );
    return NextResponse.json({ error: first.message, reason: first.reason }, { status: 502 });
  }

  console.warn(`[gemini-score-composite] retrying once (remainingBudgetMs=${remaining})`);
  const second = await callGeminiOnce(callArgs);
  if (second.ok) {
    console.log('[gemini-score-composite] retry succeeded');
    return NextResponse.json({ score: second.score, latencyMs: second.latencyMs });
  }
  console.error(`[gemini-score-composite][failure] reason=${second.reason} attempt=2 message=${second.message}`);
  console.error(
    `[gemini-score-composite][fallback] reason=${second.reason} retried=true firstReason=${first.reason}`,
  );
  return NextResponse.json({ error: second.message, reason: second.reason }, { status: 502 });
}
