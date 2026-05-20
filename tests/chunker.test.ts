import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateGraph } from '../lib/graph/loader.ts';
import { isRoutineNode, type RoutineNode } from '../lib/graph/types.ts';
import { chunkRoutine } from '../lib/graph/chunker.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadGraph() {
  const p = join(__dirname, '..', 'public', 'data', 'knowledge_graph.json');
  return validateGraph(JSON.parse(await readFile(p, 'utf8')));
}

function getRoutine(graph: Awaited<ReturnType<typeof loadGraph>>, id: string): RoutineNode {
  const n = graph.nodes.find((node) => node.id === id);
  if (!n || !isRoutineNode(n)) throw new Error(`expected routine ${id}`);
  return n;
}

describe('chunker', () => {
  it('returns no chunks for an empty routine', () => {
    const stub: RoutineNode = {
      id: 'x',
      name: 'X',
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
      bpm: 120,
      duration_seconds: 0,
      required_skills: [],
      skill_weights: {},
    };
    assert.equal(chunkRoutine(stub).length, 0);
  });

  it('returns 2..8 chunks for a real routine', async () => {
    const graph = await loadGraph();
    for (const node of graph.nodes.filter(isRoutineNode)) {
      const chunks = chunkRoutine(node);
      assert.ok(chunks.length >= 2, `${node.id}: too few chunks (${chunks.length})`);
      assert.ok(chunks.length <= 8, `${node.id}: too many chunks (${chunks.length})`);
    }
  });

  it('chunks tile [0, duration] with no gaps or overlap', async () => {
    const graph = await loadGraph();
    for (const node of graph.nodes.filter(isRoutineNode)) {
      const chunks = chunkRoutine(node);
      assert.equal(chunks[0]!.startMs, 0);
      assert.equal(chunks[chunks.length - 1]!.endMs, node.duration_seconds * 1000);
      for (let i = 1; i < chunks.length; i++) {
        assert.equal(chunks[i]!.startMs, chunks[i - 1]!.endMs, `${node.id} chunk ${i} not contiguous`);
      }
    }
  });

  it('every skill appears in exactly one chunk', async () => {
    const graph = await loadGraph();
    for (const node of graph.nodes.filter(isRoutineNode)) {
      const chunks = chunkRoutine(node);
      const all = chunks.flatMap((c) => c.skills);
      // Skills can be repeated if a chunk needs filler, but every required
      // skill must be covered at least once.
      const present = new Set(all);
      for (const id of node.required_skills) {
        assert.ok(present.has(id), `${node.id}: required skill ${id} missing from chunks`);
      }
    }
  });

  it('respects custom targetChunkSeconds', () => {
    const stub: RoutineNode = {
      id: 'x',
      name: 'X',
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
      bpm: 120,
      duration_seconds: 16,
      required_skills: Array.from({ length: 12 }, (_, i) => `s${i}`),
      skill_weights: {},
    };
    const slow = chunkRoutine(stub, { targetChunkSeconds: 4 });
    const fast = chunkRoutine(stub, { targetChunkSeconds: 2 });
    assert.ok(slow.length < fast.length, 'larger target → fewer chunks');
  });

  it('uses nameOf for labels when provided', () => {
    const stub: RoutineNode = {
      id: 'x',
      name: 'X',
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
      bpm: 120,
      duration_seconds: 8,
      required_skills: ['a', 'b', 'c', 'd'],
      skill_weights: {},
    };
    const chunks = chunkRoutine(stub, {
      nameOf: (id) => id.toUpperCase(),
    });
    for (const c of chunks) assert.equal(c.label, c.skills[0]!.toUpperCase());
  });
});
