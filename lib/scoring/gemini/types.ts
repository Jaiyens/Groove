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

export const GeminiScoreSchema = z.object({
  is_actually_dancing: z.boolean(),
  overall_score: z.number().min(0).max(100),
  tier: z.enum(['GROOVY', 'SOLID', 'SHAKY', 'NOT_DANCING']),
  components: z.object({
    arms: z.number().min(0).max(100),
    legs: z.number().min(0).max(100),
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
        legs: { type: 'number', minimum: 0, maximum: 100 },
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
