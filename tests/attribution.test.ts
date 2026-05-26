import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAttributionOverride } from '../lib/mastery/useRecordDanceAttempt.ts';
import { buildTeachingRecommendation } from '../lib/graph/teachingRecommender.ts';
import type { KnowledgeGraph, SkillNode } from '../lib/graph/types.ts';
import type { Dance } from '../lib/dances/types.ts';
import type { DanceScore } from '../lib/scoring/gemini/score-attempt.ts';

function skill(
  id: string,
  category: SkillNode['category'] = 'isolation',
): SkillNode {
  return {
    id,
    name: id.replace(/_/g, ' '),
    layer: 2,
    category,
    description: '',
    prerequisites: [],
    measurable_success_criterion: '',
    drill_description: '',
    drill_duration_seconds: 30,
    mastery_threshold: '',
    common_mistakes: [],
    sources: [],
  };
}

function graphWith(nodes: SkillNode[]): KnowledgeGraph {
  return { nodes, version: 'test', generated_at: '' };
}

function dance(required: string[], weights?: Record<string, number>): Dance {
  return {
    id: 'd1',
    name: 'Test Dance',
    artist: 'Test',
    video_url: null,
    skeleton_video_url: null,
    audio_url: null,
    thumbnail_url: null,
    tiktok_url: '',
    bpm: 100,
    duration_seconds: 20,
    required_skills: required,
    skill_weights: weights ?? {},
    pose_data_url: null,
    low_quality: false,
    audio_start_offset_ms: 0,
  };
}

function score(opts: {
  attributed?: string | null;
  fixText?: string;
}): DanceScore {
  return {
    reasoning: '',
    scores: { timing: 75, shape: 75, energy: 75, flow: 75, overall: 75 },
    fixes: [
      {
        timestamp: '00:02',
        what_happened: 'soft shoulder iso',
        fix: opts.fixText ?? 'punch the shoulder isolation harder',
        attributed_skill_id: opts.attributed ?? null,
      },
    ],
    did_well: { timestamp: '00:01', note: 'good posture' },
    summary: 'ok',
  };
}

describe('buildAttributionOverride', () => {
  const skills = [
    skill('shoulder_iso'),
    skill('hip_iso_lateral'),
    skill('arm_extension', 'combo'),
  ];
  const g = graphWith(skills);
  const d = dance(['shoulder_iso', 'hip_iso_lateral', 'arm_extension'], {
    shoulder_iso: 0.2,
    hip_iso_lateral: 0.3,
    arm_extension: 0.5,
  });
  const projection = { shoulder_iso: 50, hip_iso_lateral: 70, arm_extension: 65 };
  const mastery = { shoulder_iso: 0.4, hip_iso_lateral: 0.5, arm_extension: 0.6 };
  const baseRec = buildTeachingRecommendation({
    dance: d,
    graph: g,
    perSkillScores: projection,
    mastery,
  });

  it('returns null when Gemini did not attribute the top fix', () => {
    const ov = buildAttributionOverride(
      score({ attributed: null }),
      d,
      skills,
      projection,
      mastery,
      baseRec,
    );
    assert.equal(ov, null);
  });

  it('returns null when there are no fixes', () => {
    const s = score({});
    s.fixes = [
      {
        timestamp: '00:02',
        what_happened: 'x',
        fix: 'y',
        attributed_skill_id: null,
      },
    ];
    // remove fixes entirely by setting an empty array — minus the schema floor
    s.fixes = [] as unknown as DanceScore['fixes'];
    const ov = buildAttributionOverride(s, d, skills, projection, mastery, baseRec);
    assert.equal(ov, null);
  });

  it('returns null when attributed id is not in this dance', () => {
    const ov = buildAttributionOverride(
      score({ attributed: 'phantom_skill' }),
      d,
      skills,
      projection,
      mastery,
      baseRec,
    );
    assert.equal(ov, null);
  });

  it('overrides with the attributed skill when it is a required skill', () => {
    // gap-based pick on these numbers picks arm_extension (heaviest weight
    // with low-ish score). Attribution to shoulder_iso should override.
    assert.equal(baseRec.weakestSkill?.skill.id, 'arm_extension');
    const ov = buildAttributionOverride(
      score({ attributed: 'shoulder_iso', fixText: 'pop the shoulder up' }),
      d,
      skills,
      projection,
      mastery,
      baseRec,
    );
    assert.ok(ov);
    assert.equal(ov!.skill.skill.id, 'shoulder_iso');
    assert.equal(ov!.skill.score, 50);
    assert.equal(ov!.skill.mastery, 0.4);
    assert.equal(ov!.skill.weight, 0.2);
    assert.equal(ov!.fix, 'pop the shoulder up');
  });

  it('reuses the recommender row (preserving gap) when the attributed skill is in skillRows', () => {
    const ov = buildAttributionOverride(
      score({ attributed: 'hip_iso_lateral' }),
      d,
      skills,
      projection,
      mastery,
      baseRec,
    );
    const fromRows = baseRec.skillRows.find(
      (r) => r.skill.id === 'hip_iso_lateral',
    );
    assert.ok(fromRows);
    assert.ok(ov);
    assert.equal(ov!.skill, fromRows);
  });

  it('synthesizes a row when the attributed skill is required but absent from skillRows', () => {
    // Build a dance with required_skills BUT skill_weights missing one of them.
    // resolveWeights inside the recommender uses skill_weights when present;
    // if skill_weights is partial, the recommender drops the unweighted skills.
    // Confirm the override re-derives a SkillRow for the dropped skill.
    const dPartial = dance(['shoulder_iso', 'hip_iso_lateral'], {
      shoulder_iso: 1.0,
    });
    const rec = buildTeachingRecommendation({
      dance: dPartial,
      graph: g,
      perSkillScores: { shoulder_iso: 60, hip_iso_lateral: 40 },
      mastery: { shoulder_iso: 0.3, hip_iso_lateral: 0.2 },
    });
    // hip_iso_lateral should not be in the recommender's rows because the
    // dance's skill_weights only weight shoulder_iso.
    assert.equal(
      rec.skillRows.find((r) => r.skill.id === 'hip_iso_lateral'),
      undefined,
    );
    const ov = buildAttributionOverride(
      score({ attributed: 'hip_iso_lateral' }),
      dPartial,
      skills.filter((s) => s.id !== 'arm_extension'),
      { shoulder_iso: 60, hip_iso_lateral: 40 },
      { shoulder_iso: 0.3, hip_iso_lateral: 0.2 },
      rec,
    );
    assert.ok(ov);
    assert.equal(ov!.skill.skill.id, 'hip_iso_lateral');
    assert.equal(ov!.skill.score, 40);
    // Fallback weight is uniform when the skill is not in skill_weights.
    assert.ok(ov!.skill.weight > 0);
  });
});
