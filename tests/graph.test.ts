import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GraphValidationError, validateGraph } from '../lib/graph/loader.ts';
import { isRoutineNode } from '../lib/graph/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadGraphJSON() {
  const p = join(__dirname, '..', 'public', 'data', 'knowledge_graph.json');
  return JSON.parse(await readFile(p, 'utf8'));
}

describe('graph loader', () => {
  it('accepts the production knowledge graph (bare-array form)', async () => {
    const data = await loadGraphJSON();
    const graph = validateGraph(data);
    // The real graph is a JSON array (no version/generated_at). The loader
    // normalises it; consumers always see version === 'unknown' for the
    // array form.
    assert.equal(graph.version, 'unknown');
    assert.ok(graph.nodes.length >= 8, 'graph should have non-trivial node count');
  });

  it('all 6 layers are represented', async () => {
    const graph = validateGraph(await loadGraphJSON());
    const layers = new Set(graph.nodes.map((n) => n.layer));
    for (const l of [1, 2, 3, 4, 5, 6]) {
      assert.ok(layers.has(l as 1 | 2 | 3 | 4 | 5 | 6), `missing layer ${l}`);
    }
  });

  it('contains routine nodes with well-formed weights', async () => {
    const graph = validateGraph(await loadGraphJSON());
    const routines = graph.nodes.filter(isRoutineNode);
    assert.ok(routines.length >= 1, 'expected at least one routine node');
    for (const r of routines) {
      assert.ok(r.bpm > 0, 'routine bpm must be positive');
      assert.ok(r.required_skills.length > 0, 'routine must have required_skills');
      const weightSum = Object.values(r.skill_weights).reduce((s, w) => s + w, 0);
      assert.ok(
        Math.abs(weightSum - 1) < 1e-3,
        `routine "${r.id}" weights sum (${weightSum}) should be ≈ 1`,
      );
    }
  });

  it('also accepts the legacy { nodes, version, generated_at } form', () => {
    const legacy = {
      version: '0.0.1-stub',
      generated_at: '2026-05-19',
      nodes: [
        {
          id: 'a',
          name: 'A',
          layer: 1,
          category: 'foundation',
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
    const graph = validateGraph(legacy);
    assert.equal(graph.version, '0.0.1-stub');
    assert.equal(graph.nodes.length, 1);
  });

  it('rejects a graph with unknown prerequisite', () => {
    const bad = [
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
    ];
    assert.throws(() => validateGraph(bad), GraphValidationError);
  });

  it('rejects a graph with missing field', () => {
    const bad = [{ id: 'a', name: 'A' }];
    assert.throws(() => validateGraph(bad), GraphValidationError);
  });

  it('rejects a layer=6 routine missing bpm/skill_weights', () => {
    const bad = [
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
    ];
    assert.throws(() => validateGraph(bad), GraphValidationError);
  });
});
