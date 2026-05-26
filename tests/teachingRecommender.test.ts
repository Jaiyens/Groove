import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTeachingRecommendation } from '../lib/graph/teachingRecommender.ts';
import type { KnowledgeGraph, SkillNode } from '../lib/graph/types.ts';
import type { Dance } from '../lib/dances/types.ts';

function skill(id: string, category: SkillNode['category'] = 'isolation'): SkillNode {
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

describe('buildTeachingRecommendation', () => {
  it('all-strong attempt: weakestSkill is null and headline reflects success', () => {
    const skills = [skill('a'), skill('b'), skill('c')];
    const rec = buildTeachingRecommendation({
      dance: dance(['a', 'b', 'c']),
      graph: graphWith(skills),
      perSkillScores: { a: 88, b: 92, c: 90 },
      mastery: { a: 0.7, b: 0.6, c: 0.5 },
    });
    assert.equal(rec.weakestSkill, null);
    assert.equal(rec.otherWeak.length, 0);
    assert.match(rec.headline, /landed|nice/i);
    assert.equal(rec.fallback, false);
  });

  it('mixed attempt: gap (not raw score) determines weakest', () => {
    const skills = [skill('heavy'), skill('light')];
    // heavy has weight 0.9, light has weight 0.1
    // heavy scored 60 → gap = 0.9 * 0.4 = 0.36
    // light scored 30 → gap = 0.1 * 0.7 = 0.07
    const rec = buildTeachingRecommendation({
      dance: dance(['heavy', 'light'], { heavy: 0.9, light: 0.1 }),
      graph: graphWith(skills),
      perSkillScores: { heavy: 60, light: 30 },
      mastery: { heavy: 0.5, light: 0.5 },
    });
    assert.ok(rec.weakestSkill);
    assert.equal(rec.weakestSkill?.skill.id, 'heavy');
  });

  it('all-weak attempt: highest-weight skill wins (gap is monotone in weight when scores equal)', () => {
    const skills = [skill('h'), skill('m'), skill('l')];
    const rec = buildTeachingRecommendation({
      dance: dance(['h', 'm', 'l'], { h: 0.5, m: 0.3, l: 0.2 }),
      graph: graphWith(skills),
      perSkillScores: { h: 30, m: 30, l: 30 },
      mastery: { h: 0.4, m: 0.4, l: 0.4 },
    });
    assert.equal(rec.weakestSkill?.skill.id, 'h');
  });

  it('weakest is null when every score is at or above the 80 ceiling', () => {
    const skills = [skill('a'), skill('b')];
    const rec = buildTeachingRecommendation({
      dance: dance(['a', 'b']),
      graph: graphWith(skills),
      perSkillScores: { a: 82, b: 80 },
      mastery: {},
    });
    assert.equal(rec.weakestSkill, null);
  });

  it('missing per-skill scores default to 0, no NaN', () => {
    const skills = [skill('a'), skill('b')];
    const rec = buildTeachingRecommendation({
      dance: dance(['a', 'b']),
      graph: graphWith(skills),
      perSkillScores: {},
      mastery: {},
    });
    assert.ok(rec.weakestSkill);
    assert.ok(Number.isFinite(rec.weakestSkill?.gap ?? NaN));
  });

  it('unknown skill ids in required_skills are skipped gracefully', () => {
    const skills = [skill('known')];
    const rec = buildTeachingRecommendation({
      dance: dance(['known', 'phantom']),
      graph: graphWith(skills),
      perSkillScores: { known: 50 },
      mastery: {},
    });
    assert.equal(rec.skillRows.length, 1);
    assert.equal(rec.skillRows[0]?.skill.id, 'known');
  });

  it('empty required_skills returns fallback', () => {
    const rec = buildTeachingRecommendation({
      dance: dance([]),
      graph: graphWith([]),
      perSkillScores: {},
      mastery: {},
    });
    assert.equal(rec.fallback, true);
    assert.equal(rec.skillRows.length, 0);
  });

  it('skillRows are sorted by weight desc', () => {
    const skills = [skill('a'), skill('b'), skill('c')];
    const rec = buildTeachingRecommendation({
      dance: dance(['a', 'b', 'c'], { a: 0.2, b: 0.5, c: 0.3 }),
      graph: graphWith(skills),
      perSkillScores: { a: 70, b: 70, c: 70 },
      mastery: {},
    });
    const ids = rec.skillRows.map((r) => r.skill.id);
    assert.deepEqual(ids, ['b', 'c', 'a']);
  });

  it('equal-gap tiebreak: lower mastery wins', () => {
    const skills = [skill('a'), skill('b')];
    // Both weight 0.5, both score 50 → gap identical (0.25 vs 0.25)
    const rec = buildTeachingRecommendation({
      dance: dance(['a', 'b'], { a: 0.5, b: 0.5 }),
      graph: graphWith(skills),
      perSkillScores: { a: 50, b: 50 },
      mastery: { a: 0.7, b: 0.3 },
    });
    assert.equal(rec.weakestSkill?.skill.id, 'b');
  });

  it('otherWeak excludes already-strong skills', () => {
    const skills = [skill('a'), skill('b'), skill('c')];
    const rec = buildTeachingRecommendation({
      dance: dance(['a', 'b', 'c']),
      graph: graphWith(skills),
      perSkillScores: { a: 30, b: 85, c: 40 },
      mastery: {},
    });
    // a (weakest) is the primary; b is too strong to recommend; c is the only otherWeak
    assert.equal(rec.weakestSkill?.skill.id, 'a');
    const otherIds = rec.otherWeak.map((r) => r.skill.id);
    assert.deepEqual(otherIds, ['c']);
  });
});
