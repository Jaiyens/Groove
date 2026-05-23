// Gemini post-attempt scoring schema. Zod runtime validation + a JSON Schema
// view for the Gemini structured-output config.
//
// NOTE on vocabulary overlap: Gemini's `tier: 'GROOVY'` and the live-callout
// `CalloutTier: 'GROOVY'` (lib/scoring/callouts/types.ts) share the word but
// are different semantic spaces. Gemini's GROOVY = overall verdict 85-100
// across the whole attempt. Live GROOVY = single-moment peak hit on one
// accent beat. Do NOT normalize them.

import { z } from 'zod';

export const TroubleSpotSchema = z.object({
  start_sec: z.number(),
  end_sec: z.number(),
  body_part: z.enum(['arms', 'legs', 'body', 'timing']),
  severity: z.enum(['minor', 'moderate', 'major']),
  what_happened: z.string(),
  fix: z.string(),
});

// SPEC: score-restoration. The Gemini API now returns a five-field response
// (score / tier / did_well / work_on / visibility_notes). The client converts
// it back into the internal `GeminiScore` shape below before the rest of the
// pipeline (deterministic layer, ResultsCard) consumes it — keeps the UI
// untouched while the model boundary follows the new spec.
export const GeminiSpecTierSchema = z.enum([
  'GROOVY',
  'SOLID',
  'ALMOST',
  'WARMING_UP',
  'JUST_STARTED',
]);

export const GeminiSpecScoreSchema = z.object({
  score: z.number().min(0).max(100),
  tier: GeminiSpecTierSchema,
  did_well: z.string(),
  work_on: z.string(),
  visibility_notes: z.string(),
});

export type GeminiSpecScore = z.infer<typeof GeminiSpecScoreSchema>;
export type GeminiSpecTier = z.infer<typeof GeminiSpecTierSchema>;

// JSON Schema view for Gemini structured-output `responseSchema`. Kept in
// sync with GeminiSpecScoreSchema above. `propertyOrdering` is a Gemini-
// specific hint that biases generation toward the canonical key order from
// the spec's worked examples.
export const GeminiSpecResponseJsonSchema = {
  type: 'object',
  properties: {
    score: { type: 'integer', minimum: 0, maximum: 100 },
    tier: {
      type: 'string',
      enum: ['GROOVY', 'SOLID', 'ALMOST', 'WARMING_UP', 'JUST_STARTED'],
    },
    did_well: { type: 'string' },
    work_on: { type: 'string' },
    visibility_notes: { type: 'string' },
  },
  required: ['score', 'tier', 'did_well', 'work_on', 'visibility_notes'],
  propertyOrdering: ['score', 'tier', 'did_well', 'work_on', 'visibility_notes'],
} as const;

export const GeminiScoreSchema = z.object({
  is_actually_dancing: z.boolean(),
  overall_score: z.number().min(0).max(100),
  tier: z.enum(['GROOVY', 'SOLID', 'SHAKY', 'NOT_DANCING']),
  components: z.object({
    arms: z.number().min(0).max(100),
    // SPECK round-3 §Group-4: legs is null when the user filmed
    // upper-body only. The downstream `displayedOverall` excludes it
    // from the mean. Older versions defaulted to 75 which lied on the
    // breakdown bar.
    legs: z.number().min(0).max(100).nullable(),
    body: z.number().min(0).max(100),
    timing: z.number().min(0).max(100),
  }),
  insights: z.array(z.string()).min(1).max(4),
  trouble_spots: z.array(TroubleSpotSchema).max(5),
});

export type TroubleSpot = z.infer<typeof TroubleSpotSchema>;
export type GeminiScore = z.infer<typeof GeminiScoreSchema>;
export type GeminiTier = GeminiScore['tier'];
export type GeminiBodyPart = TroubleSpot['body_part'];
export type GeminiSeverity = TroubleSpot['severity'];

// Hand-written JSON Schema for Gemini's structured-output `responseSchema`
// field. Kept in sync with GeminiScoreSchema above. Using OBJECT/STRING/
// NUMBER/BOOLEAN/ARRAY type strings per the Gemini API spec.
export const GeminiResponseJsonSchema = {
  type: 'object',
  properties: {
    is_actually_dancing: { type: 'boolean' },
    overall_score: { type: 'number', minimum: 0, maximum: 100 },
    tier: { type: 'string', enum: ['GROOVY', 'SOLID', 'SHAKY', 'NOT_DANCING'] },
    components: {
      type: 'object',
      properties: {
        arms: { type: 'number', minimum: 0, maximum: 100 },
        // SPECK round-3 §Group-4: legs nullable for upper-body-only attempts.
        // Gemini structured-output (OpenAPI-style) uses `nullable: true`.
        legs: { type: 'number', minimum: 0, maximum: 100, nullable: true },
        body: { type: 'number', minimum: 0, maximum: 100 },
        timing: { type: 'number', minimum: 0, maximum: 100 },
      },
      required: ['arms', 'legs', 'body', 'timing'],
    },
    insights: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 4,
    },
    trouble_spots: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          start_sec: { type: 'number' },
          end_sec: { type: 'number' },
          body_part: { type: 'string', enum: ['arms', 'legs', 'body', 'timing'] },
          severity: { type: 'string', enum: ['minor', 'moderate', 'major'] },
          what_happened: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['start_sec', 'end_sec', 'body_part', 'severity', 'what_happened', 'fix'],
      },
    },
  },
  required: [
    'is_actually_dancing',
    'overall_score',
    'tier',
    'components',
    'insights',
    'trouble_spots',
  ],
} as const;
