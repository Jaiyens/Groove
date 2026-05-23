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

import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

import { buildGeminiPrompt } from '@/lib/scoring/gemini/prompt';
import {
  GeminiResponseJsonSchema,
  GeminiScoreSchema,
} from '@/lib/scoring/gemini/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

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
  } = body;

  console.log('[gemini-score] referenceVideoBase64 length:', referenceVideoBase64?.length ?? 'MISSING');
  console.log('[gemini-score] attemptVideoBase64 length:', attemptVideoBase64?.length ?? 'MISSING');
  console.log('[gemini-score] referenceMimeType:', referenceMimeType);
  console.log('[gemini-score] attemptMimeType:', attemptMimeType);
  console.log('[gemini-score] legsVisible:', legsVisible);
  console.log('[gemini-score] referenceChunkStartSec:', referenceChunkStartSec);
  console.log('[gemini-score] referenceChunkEndSec:', referenceChunkEndSec);

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
  const startTime = Date.now();

  try {
    const prompt = buildGeminiPrompt({
      legsVisible,
      referenceChunkStartSec,
      referenceChunkEndSec: resolvedChunkEndSec,
    });

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            { text: 'REFERENCE:' },
            {
              inlineData: {
                mimeType: referenceMimeType || 'video/mp4',
                data: referenceVideoBase64,
              },
            },
            { text: 'ATTEMPT:' },
            {
              inlineData: {
                mimeType: attemptMimeType || 'video/mp4',
                data: attemptVideoBase64,
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

    console.log('[gemini-score] raw response text:', response.text);
    console.log('[gemini-score] latencyMs:', Date.now() - startTime);

    const latencyMs = Date.now() - startTime;
    const text = response.text;
    if (!text) {
      return NextResponse.json(
        { error: 'Gemini returned empty response' },
        { status: 502 },
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch (err) {
      // Schema is the contract (SPECK §Hard rule 6). No regex repair attempts.
      // eslint-disable-next-line no-console
      console.error('[gemini-score] response was not valid JSON', err);
      return NextResponse.json(
        { error: 'Gemini response was not valid JSON' },
        { status: 502 },
      );
    }

    const parsed = GeminiScoreSchema.safeParse(parsedJson);
    if (!parsed.success) {
      // eslint-disable-next-line no-console
      console.error('[gemini-score] schema validation failed', parsed.error.flatten());
      return NextResponse.json(
        { error: `Gemini response failed schema validation` },
        { status: 502 },
      );
    }

    return NextResponse.json({ score: parsed.data, latencyMs });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[gemini-score] generateContent failed', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
