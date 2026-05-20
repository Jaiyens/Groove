import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GraphValidationError, validateGraph } from '../lib/graph/loader.ts';
import { isRoutineNode } from '../lib/graph/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadStub() {
  const p = join(__dirname, '..', 'public', 'data', 'knowledge_graph.json');
  return JSON.parse(await readFile(p, 'utf8'));
}

describe('graph loader', () => {
  it('accepts the stub knowledge graph', async () => {
    const stub = await loadStub();
    const graph = validateGraph(stub);
    assert.equal(graph.version, '0.0.1-stub');
    assert.equal(graph.nodes.length, 8);
  });

  it('all 6 layers are represented in the stub', async () => {
    const stub = await loadStub();
    const graph = validateGraph(stub);
    const layers = new Set(graph.nodes.map((n) => n.layer));
    for (const l of [1, 2, 3, 4, 5, 6]) {
      assert.ok(layers.has(l as 1 | 2 | 3 | 4 | 5 | 6), `missing layer ${l}`);
    }
  });

  it('contains at least one routine node', async () => {
    const stub = await loadStub();
    const graph = validateGraph(stub);
    const routines = graph.nodes.filter(isRoutineNode);
    assert.ok(routines.length >= 1, 'expected at least one routine node');
    for (const r of routines) {
      assert.ok(r.bpm > 0, 'routine bpm must be positive');
      assert.ok(r.required_skills.length > 0, 'routine must have required_skills');
      const weightSum = Object.values(r.skill_weights).reduce((s, w) => s + w, 0);
      assert.ok(
        Math.abs(weightSum - 1) < 1e-6 || weightSum <= 1.01,
        `routine "${r.id}" weights sum (${weightSum}) should be near 1`,
      );
    }
  });

  it('rejects a graph with unknown prerequisite', () => {
    const bad = {
      version: '0',
      generated_at: '2026-01-01',
      nodes: [
        {
          id: 'a',
          name: 'A',
          layer: 1,
          category: 'foundation',
          description: '',
          prerequisites: ['does_not_exist'],
          measurable_success_criterion: '',
          drill_description: '',
          drill_duration_seconds: 0,
          mastery_threshold: '',
          common_mistakes: [],
          sources: [],
        },
      ],
    };
    assert.throws(() => validateGraph(bad), GraphValidationError);
  });

  it('rejects a graph with missing field', () => {
    const bad = {
      version: '0',
      generated_at: '2026-01-01',
      nodes: [
        { id: 'a', name: 'A' },
      ],
    };
    assert.throws(() => validateGraph(bad), GraphValidationError);
  });

  it('rejects a layer=6 routine missing bpm/skill_weights', () => {
    const bad = {
      version: '0',
      generated_at: '2026-01-01',
      nodes: [
        {
          id: 'r',
          name: 'R',
          layer: 6,
          category: 'routine',
          description: '',
          prerequisites: [],
          measurable_success_criterion: '',
          drill_description: '',
          drill_duration_seconds: 0,
          mastery_threshold: '',
          common_mistakes: [],
          sources: [],
        },
      ],
    };
    assert.throws(() => validateGraph(bad), GraphValidationError);
  });
});
