import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateGraph } from '../lib/graph/loader.ts';
import { computeReadiness } from '../lib/graph/readiness.ts';
import { recommendNextDrill } from '../lib/graph/recommender.ts';
import { DANCES } from '../lib/dances/fixtures.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadGraph() {
  const p = join(__dirname, '..', 'public', 'data', 'knowledge_graph.json');
  return validateGraph(JSON.parse(await readFile(p, 'utf8')));
}

describe('readiness', () => {
  it('returns 0% for a brand new user', async () => {
    const graph = await loadGraph();
    for (const dance of DANCES) {
      const r = computeReadiness({ dance, graph, mastery: {} });
      assert.equal(r.percent, 0, `dance ${dance.id} should be 0%`);
      assert.ok(r.perSkill.length === dance.required_skills.length);
    }
  });

  it('returns 100% when all required skills are fully mastered', async () => {
    const graph = await loadGraph();
    for (const dance of DANCES) {
      const fullMastery: Record<string, number> = {};
      for (const sid of dance.required_skills) fullMastery[sid] = 1;
      const r = computeReadiness({ dance, graph, mastery: fullMastery });
      assert.equal(r.percent, 100, `${dance.id} should be 100%`);
    }
  });

  it('uses routine skill_weights when dance.id matches a routine node', async () => {
    const graph = await loadGraph();
    const apt = DANCES.find((d) => d.id === 'fixture_apt');
    assert.ok(apt);
    // Master only body_roll (weight 0.35 in stub routine).
    const mastery = { stub_body_roll: 1 };
    const r = computeReadiness({ dance: apt, graph, mastery });
    assert.equal(r.percent, 35);
  });

  it('falls back to uniform weights when no routine node matches', async () => {
    const graph = await loadGraph();
    const espresso = DANCES.find((d) => d.id === 'fixture_espresso');
    assert.ok(espresso);
    // espresso has 2 skills, uniform weight 0.5 each. Master one fully -> 50%.
    const r = computeReadiness({
      dance: espresso,
      graph,
      mastery: { stub_two_step: 1, stub_shoulder_iso: 0 },
    });
    assert.equal(r.percent, 50);
  });
});

describe('recommender', () => {
  it('picks the highest-gap skill for a brand-new user (weighted)', async () => {
    const graph = await loadGraph();
    const apt = DANCES.find((d) => d.id === 'fixture_apt');
    assert.ok(apt);
    const rec = recommendNextDrill({ dance: apt, graph, mastery: {} });
    assert.ok(rec);
    // body_roll has the highest weight (0.35) and mastery 0, so gap is largest.
    assert.equal(rec.skill.id, 'stub_body_roll');
  });

  it('avoids re-recommending an already-mastered skill', async () => {
    const graph = await loadGraph();
    const apt = DANCES.find((d) => d.id === 'fixture_apt');
    assert.ok(apt);
    const rec = recommendNextDrill({
      dance: apt,
      graph,
      mastery: { stub_body_roll: 1, stub_two_step: 0, stub_shoulder_iso: 0, stub_arm_wave: 0 },
    });
    assert.ok(rec);
    assert.notEqual(rec.skill.id, 'stub_body_roll');
    // next highest weight: two_step at 0.25
    assert.equal(rec.skill.id, 'stub_two_step');
  });

  it('returns a skill node populated with drill_description', async () => {
    const graph = await loadGraph();
    const renegade = DANCES.find((d) => d.id === 'fixture_renegade');
    assert.ok(renegade);
    const rec = recommendNextDrill({ dance: renegade, graph, mastery: {} });
    assert.ok(rec);
    assert.ok(rec.skill.drill_description.length > 0);
    assert.ok(rec.skill.drill_duration_seconds > 0);
  });
});
