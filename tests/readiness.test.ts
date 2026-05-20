import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateGraph } from '../lib/graph/loader.ts';
import { computeReadiness } from '../lib/graph/readiness.ts';
import { recommendNextDrill } from '../lib/graph/recommender.ts';
import { DANCES, resolveDance } from '../lib/dances/fixtures.ts';
import { isRoutineNode, type KnowledgeGraph, type RoutineNode } from '../lib/graph/types.ts';
import type { Dance } from '../lib/dances/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadGraph(): Promise<KnowledgeGraph> {
  const p = join(__dirname, '..', 'public', 'data', 'knowledge_graph.json');
  return validateGraph(JSON.parse(await readFile(p, 'utf8')));
}

function resolvedDances(graph: KnowledgeGraph): Dance[] {
  return DANCES.map((f) => resolveDance(f, graph)).filter(
    (d): d is Dance => Boolean(d),
  );
}

function routineFor(graph: KnowledgeGraph, id: string): RoutineNode {
  const n = graph.nodes.find((node) => node.id === id);
  if (!n || !isRoutineNode(n)) {
    throw new Error(`expected routine node ${id} in graph`);
  }
  return n;
}

describe('readiness', () => {
  it('every fixture resolves to a routine node in the graph', async () => {
    const graph = await loadGraph();
    const resolved = resolvedDances(graph);
    assert.equal(
      resolved.length,
      DANCES.length,
      `expected all ${DANCES.length} fixtures to resolve, got ${resolved.length}`,
    );
  });

  it('returns 0% for a brand new user', async () => {
    const graph = await loadGraph();
    for (const dance of resolvedDances(graph)) {
      const r = computeReadiness({ dance, graph, mastery: {} });
      assert.equal(r.percent, 0, `dance ${dance.id} should be 0%`);
      assert.ok(r.perSkill.length === dance.required_skills.length);
    }
  });

  it('returns 100% when all required skills are fully mastered', async () => {
    const graph = await loadGraph();
    for (const dance of resolvedDances(graph)) {
      const fullMastery: Record<string, number> = {};
      for (const sid of dance.required_skills) fullMastery[sid] = 1;
      const r = computeReadiness({ dance, graph, mastery: fullMastery });
      assert.equal(r.percent, 100, `${dance.id} should be 100%`);
    }
  });

  it('uses routine skill_weights (one fully-mastered skill = that skill\'s weight)', async () => {
    const graph = await loadGraph();
    const golden = resolveDance(DANCES[0]!, graph)!;
    const routine = routineFor(graph, 'routine_golden');
    // Master only the heaviest-weighted skill. Readiness % should equal its
    // weight (since other skills are 0 mastery).
    const [heaviestId, heaviestWeight] = Object.entries(routine.skill_weights)
      .sort((a, b) => b[1] - a[1])[0]!;
    const r = computeReadiness({
      dance: golden,
      graph,
      mastery: { [heaviestId]: 1 },
    });
    assert.equal(r.percent, Math.round(heaviestWeight * 100));
  });
});

describe('recommender', () => {
  it('picks the highest-gap (highest-weight) skill for a brand-new user', async () => {
    const graph = await loadGraph();
    const golden = resolveDance(DANCES[0]!, graph)!;
    const routine = routineFor(graph, 'routine_golden');
    const heaviestId = Object.entries(routine.skill_weights).sort(
      (a, b) => b[1] - a[1],
    )[0]![0];
    const rec = recommendNextDrill({ dance: golden, graph, mastery: {} });
    assert.ok(rec, 'expected a recommendation');
    assert.equal(rec!.skill.id, heaviestId);
  });

  it('avoids re-recommending an already-mastered skill', async () => {
    const graph = await loadGraph();
    const golden = resolveDance(DANCES[0]!, graph)!;
    const routine = routineFor(graph, 'routine_golden');
    const sortedByWeight = Object.entries(routine.skill_weights).sort(
      (a, b) => b[1] - a[1],
    );
    const heaviestId = sortedByWeight[0]![0];
    const secondId = sortedByWeight[1]![0];
    const rec = recommendNextDrill({
      dance: golden,
      graph,
      mastery: { [heaviestId]: 1 },
    });
    assert.ok(rec);
    assert.notEqual(rec!.skill.id, heaviestId);
    assert.equal(rec!.skill.id, secondId);
  });

  it('returns a skill node populated with drill_description', async () => {
    const graph = await loadGraph();
    const dead = resolveDance(DANCES[1]!, graph)!;
    const rec = recommendNextDrill({ dance: dead, graph, mastery: {} });
    assert.ok(rec);
    assert.ok(rec!.skill.drill_description.length > 0);
    assert.ok(rec!.skill.drill_duration_seconds > 0);
  });
});
