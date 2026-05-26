import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORY_AXIS_WEIGHTS,
  projectOneSkill,
  projectSkillScores,
  type AxisScores,
} from '../lib/graph/skillScoreProjection.ts';
import type { SkillNode } from '../lib/graph/types.ts';

function skill(
  id: string,
  category: SkillNode['category'],
  overrides: Partial<SkillNode> = {},
): SkillNode {
  return {
    id,
    name: id,
    layer: 1,
    category,
    description: '',
    prerequisites: [],
    measurable_success_criterion: '',
    drill_description: '',
    drill_duration_seconds: 30,
    mastery_threshold: '',
    common_mistakes: [],
    sources: [],
    ...overrides,
  };
}

const strong: AxisScores = { timing: 92, shape: 90, energy: 88, flow: 86, overall: 90 };
const weak: AxisScores = { timing: 30, shape: 28, energy: 32, flow: 26, overall: 30 };

describe('projectSkillScores', () => {
  it('strong attempt produces strong per-skill scores across categories', () => {
    const skills = [
      skill('a', 'foundation'),
      skill('b', 'isolation'),
      skill('c', 'travel'),
      skill('d', 'combo'),
      skill('e', 'vocabulary'),
    ];
    const out = projectSkillScores(strong, skills);
    for (const s of skills) {
      assert.ok(out[s.id] >= 85, `${s.id} should be >=85, got ${out[s.id]}`);
    }
  });

  it('weak attempt produces weak per-skill scores across categories', () => {
    const skills = [
      skill('a', 'foundation'),
      skill('b', 'isolation'),
      skill('c', 'travel'),
      skill('d', 'combo'),
      skill('e', 'vocabulary'),
    ];
    const out = projectSkillScores(weak, skills);
    for (const s of skills) {
      assert.ok(out[s.id] <= 35, `${s.id} should be <=35, got ${out[s.id]}`);
    }
  });

  it('isolation weights shape more than foundation does', () => {
    // shape strong, others weak: isolation should beat foundation
    const scores: AxisScores = { timing: 30, shape: 95, energy: 40, flow: 40, overall: 50 };
    const iso = projectOneSkill(skill('iso', 'isolation'), scores);
    const fnd = projectOneSkill(skill('fnd', 'foundation'), scores);
    assert.ok(iso > fnd, `iso(${iso}) should beat fnd(${fnd}) when shape strong`);
  });

  it('foundation weights timing more than isolation does', () => {
    // timing strong, others weak: foundation should beat isolation
    const scores: AxisScores = { timing: 95, shape: 30, energy: 40, flow: 40, overall: 50 };
    const fnd = projectOneSkill(skill('fnd', 'foundation'), scores);
    const iso = projectOneSkill(skill('iso', 'isolation'), scores);
    assert.ok(fnd > iso, `fnd(${fnd}) should beat iso(${iso}) when timing strong`);
  });

  it('travel weights flow most heavily', () => {
    const w = CATEGORY_AXIS_WEIGHTS.travel;
    assert.ok(w.flow >= Math.max(w.timing, w.shape, w.energy));
  });

  it('routine category passes through `overall` verbatim', () => {
    const r = skill('r', 'routine');
    assert.equal(projectOneSkill(r, strong), 90);
    assert.equal(projectOneSkill(r, weak), 30);
  });

  it('per-skill `axis_weights` override beats category default', () => {
    // Default isolation is shape-heavy. Override to be timing-only.
    const overridden = skill('o', 'isolation', {
      axis_weights: { timing: 1, shape: 0, energy: 0, flow: 0 },
    });
    const defaultIso = skill('d', 'isolation');
    // shape strong, timing weak: override should score lower than default
    const scores: AxisScores = { timing: 20, shape: 95, energy: 50, flow: 50, overall: 70 };
    const overridden_score = projectOneSkill(overridden, scores);
    const default_score = projectOneSkill(defaultIso, scores);
    assert.ok(
      overridden_score < default_score,
      `override(${overridden_score}) should beat default(${default_score})`,
    );
    assert.equal(overridden_score, 20); // pure timing
  });

  it('clamps out-of-range axes to 0..100', () => {
    const scores: AxisScores = { timing: 150, shape: -20, energy: 50, flow: 50, overall: 50 };
    const out = projectOneSkill(skill('s', 'combo'), scores);
    assert.ok(out >= 0 && out <= 100, `clamped result should be in [0,100], got ${out}`);
  });

  it('handles empty skill list without error', () => {
    const out = projectSkillScores(strong, []);
    assert.deepEqual(out, {});
  });

  it('non-finite inputs degrade to 0 rather than NaN', () => {
    const scores: AxisScores = {
      timing: NaN,
      shape: Infinity,
      energy: 50,
      flow: 50,
      overall: 50,
    };
    const out = projectOneSkill(skill('s', 'combo'), scores);
    assert.ok(Number.isFinite(out), `expected finite, got ${out}`);
    assert.ok(out >= 0 && out <= 100);
  });
});
