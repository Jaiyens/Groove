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

import { GEMINI_SCORING_PROMPT } from '@/lib/scoring/gemini/prompt';
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
  } = body;

  if (!referenceVideoBase64 || !attemptVideoBase64) {
    return NextResponse.json(
      { error: 'Missing videos: need referenceVideoBase64 and attemptVideoBase64' },
      { status: 400 },
    );
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'GEMINI_API_KEY not configured' }, { status: 500 });
  }

  const ai = new GoogleGenAI({ apiKey });
  const startTime = Date.now();

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            { text: GEMINI_SCORING_PROMPT },
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
