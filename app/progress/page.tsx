'use client';

// Skills tab — view-only mastery map.
//
// Two views:
//   - 'list' (default): one row per non-routine skill, grouped by category.
//     Mastery bar + tier label. The personal index.
//   - 'graph': a 5-column SVG by layer (foundations → vocabulary) showing
//     prereq edges and tier-colored nodes. Locked skills (any prereq below
//     0.5 mastery) are shown desaturated + smaller so unlocking is visible
//     without gating navigation.
//
// Either view, tapping a node routes to /drill/<id>?from=/progress. No
// curriculum gating — the graph view is descriptive, not prescriptive.

import Link from 'next/link';
import { useMemo, useState } from 'react';
import CreamBottomNav from '@/components/library/CreamBottomNav';
import { tierBarFor, tierFillFor, tierLabelFor } from '@/components/results/tier';
import { useGraph } from '@/lib/graph/context';
import type { SkillCategory, SkillLayer, SkillNode } from '@/lib/graph/types';

const CATEGORY_ORDER: SkillCategory[] = [
  'foundation',
  'isolation',
  'travel',
  'combo',
  'vocabulary',
];

const CATEGORY_LABEL: Record<SkillCategory, string> = {
  foundation: 'foundation',
  isolation: 'isolations',
  travel: 'travel',
  combo: 'combos',
  vocabulary: 'vocabulary',
  routine: 'routines',
};

type ViewMode = 'list' | 'graph';

export default function SkillsPage() {
  const { graph, mastery } = useGraph();
  const [view, setView] = useState<ViewMode>('list');

  const grouped = useMemo(() => {
    if (!graph) return null;
    const buckets: Partial<Record<SkillCategory, SkillNode[]>> = {};
    for (const node of graph.nodes) {
      if (node.category === 'routine') continue;
      const arr = buckets[node.category] ?? (buckets[node.category] = []);
      arr.push(node);
    }
    for (const cat of CATEGORY_ORDER) {
      const arr = buckets[cat];
      if (!arr) continue;
      arr.sort((a, b) => {
        const ma = mastery[a.id] ?? 0;
        const mb = mastery[b.id] ?? 0;
        if (mb !== ma) return mb - ma;
        return a.name.localeCompare(b.name);
      });
    }
    return buckets;
  }, [graph, mastery]);

  return (
    <main className="theme-cream flex h-full w-full flex-col bg-cream">
      <header className="safe-top px-6 pt-6 pb-3">
        <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-ink-muted">
          your moves
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink">
          skills you&apos;ve been tightening
        </h1>
        <p className="mt-1 text-sm leading-snug text-ink-muted">
          Tap any move to drill it on its own.
        </p>
        <ViewToggle value={view} onChange={setView} />
      </header>

      <div className="flex-1 overflow-y-auto px-6 pb-6">
        {!grouped || !graph ? (
          <p className="mt-12 text-center text-sm text-ink-muted">loading…</p>
        ) : view === 'graph' ? (
          <SkillGraphView nodes={graph.nodes} mastery={mastery} />
        ) : (
          <div className="space-y-7">
            {CATEGORY_ORDER.map((cat) => {
              const skills = grouped[cat];
              if (!skills || skills.length === 0) return null;
              return (
                <section key={cat}>
                  <h2 className="mb-2 text-[11px] font-bold uppercase tracking-[0.2em] text-ink-muted">
                    {CATEGORY_LABEL[cat]}
                  </h2>
                  <ul className="space-y-1.5">
                    {skills.map((skill) => (
                      <SkillRow
                        key={skill.id}
                        skill={skill}
                        mastery={mastery[skill.id] ?? 0}
                      />
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </div>
      <CreamBottomNav />
    </main>
  );
}

function ViewToggle({
  value,
  onChange,
}: {
  value: ViewMode;
  onChange: (next: ViewMode) => void;
}) {
  const baseBtn =
    'flex-1 rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.16em] transition';
  return (
    <div
      role="tablist"
      aria-label="Skills view"
      className="mt-3 inline-flex w-fit gap-1 rounded-full bg-cream-card p-1 ring-1 ring-cream-deep/60"
    >
      <button
        type="button"
        role="tab"
        aria-selected={value === 'list'}
        onClick={() => onChange('list')}
        className={`${baseBtn} ${
          value === 'list' ? 'bg-ink text-cream-card' : 'text-ink-muted'
        }`}
      >
        list
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={value === 'graph'}
        onClick={() => onChange('graph')}
        className={`${baseBtn} ${
          value === 'graph' ? 'bg-ink text-cream-card' : 'text-ink-muted'
        }`}
      >
        graph
      </button>
    </div>
  );
}

// Five-column SVG layout: layer 1 leftmost, layer 5 rightmost. Routines
// (layer 6) excluded — this is the skill graph, not the routine library.
//
// Locked = any prereq has mastery < 0.5. Locked nodes are drawn smaller +
// desaturated so it's visible the user hasn't laid the foundations, but
// the link still routes through (we don't gate practice).
const GRAPH_LAYERS: SkillLayer[] = [1, 2, 3, 4, 5];
const GRAPH_LAYER_LABEL: Record<SkillLayer, string> = {
  1: 'foundation',
  2: 'isolation',
  3: 'travel',
  4: 'combo',
  5: 'vocab',
  6: 'routine',
};
const COL_WIDTH = 80;
const ROW_HEIGHT = 56;
const NODE_R = 16;
const NODE_R_LOCKED = 11;
const TOP_PAD = 28;
const BOTTOM_PAD = 28;
const LABEL_GAP = 24;

function SkillGraphView({
  nodes,
  mastery,
}: {
  nodes: SkillNode[];
  mastery: Record<string, number>;
}) {
  const { positions, lockedById, viewWidth, viewHeight } = useMemo(() => {
    const byLayer = new Map<SkillLayer, SkillNode[]>();
    for (const n of nodes) {
      if (n.category === 'routine') continue;
      const arr = byLayer.get(n.layer) ?? [];
      arr.push(n);
      byLayer.set(n.layer, arr);
    }
    // Stable order within a layer: descending mastery, then name.
    for (const arr of byLayer.values()) {
      arr.sort((a, b) => {
        const ma = mastery[a.id] ?? 0;
        const mb = mastery[b.id] ?? 0;
        if (mb !== ma) return mb - ma;
        return a.name.localeCompare(b.name);
      });
    }
    const pos = new Map<string, { x: number; y: number }>();
    let maxCol = 0;
    for (const layer of GRAPH_LAYERS) {
      const arr = byLayer.get(layer) ?? [];
      maxCol = Math.max(maxCol, arr.length);
      const colX = (layer - 1) * COL_WIDTH + COL_WIDTH / 2;
      arr.forEach((skill, i) => {
        pos.set(skill.id, { x: colX, y: TOP_PAD + i * ROW_HEIGHT });
      });
    }
    const locked = new Map<string, boolean>();
    for (const n of nodes) {
      if (n.category === 'routine') continue;
      const isLocked = n.prerequisites.some((p) => (mastery[p] ?? 0) < 0.5);
      locked.set(n.id, isLocked);
    }
    const width = GRAPH_LAYERS.length * COL_WIDTH;
    const height = TOP_PAD + maxCol * ROW_HEIGHT + BOTTOM_PAD + LABEL_GAP;
    return {
      positions: pos,
      lockedById: locked,
      viewWidth: width,
      viewHeight: height,
    };
  }, [nodes, mastery]);

  const edges: { from: string; to: string }[] = [];
  for (const n of nodes) {
    if (n.category === 'routine') continue;
    if (!positions.has(n.id)) continue;
    for (const p of n.prerequisites) {
      if (positions.has(p)) edges.push({ from: p, to: n.id });
    }
  }

  return (
    <div className="overflow-x-auto pb-2">
      <svg
        viewBox={`0 0 ${viewWidth} ${viewHeight}`}
        className="block min-w-full"
        style={{ minHeight: viewHeight }}
        role="img"
        aria-label="Skill prerequisite graph"
      >
        {/* Edges first so nodes draw over them */}
        <g stroke="currentColor" className="text-ink/20" fill="none">
          {edges.map((e) => {
            const a = positions.get(e.from)!;
            const b = positions.get(e.to)!;
            return (
              <line
                key={`${e.from}-${e.to}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                strokeWidth={1}
              />
            );
          })}
        </g>
        {/* Layer labels at the bottom */}
        <g>
          {GRAPH_LAYERS.map((layer) => (
            <text
              key={layer}
              x={(layer - 1) * COL_WIDTH + COL_WIDTH / 2}
              y={viewHeight - BOTTOM_PAD / 2}
              textAnchor="middle"
              className="fill-ink-muted text-[10px] font-bold uppercase tracking-[0.18em]"
            >
              {GRAPH_LAYER_LABEL[layer]}
            </text>
          ))}
        </g>
        {/* Nodes */}
        {nodes
          .filter((n) => positions.has(n.id))
          .map((n) => {
            const p = positions.get(n.id)!;
            const locked = lockedById.get(n.id) ?? false;
            const pct = Math.max(
              0,
              Math.min(100, Math.round((mastery[n.id] ?? 0) * 100)),
            );
            return (
              <GraphNode
                key={n.id}
                x={p.x}
                y={p.y}
                skill={n}
                pct={pct}
                locked={locked}
              />
            );
          })}
      </svg>
    </div>
  );
}

function GraphNode({
  x,
  y,
  skill,
  pct,
  locked,
}: {
  x: number;
  y: number;
  skill: SkillNode;
  pct: number;
  locked: boolean;
}) {
  const tierClass = tierFillFor(pct);
  const r = locked ? NODE_R_LOCKED : NODE_R;
  return (
    <Link
      href={`/drill/${skill.id}?from=/progress`}
      aria-label={`${skill.name}, ${pct}% mastery${locked ? ' (locked)' : ''}`}
    >
      <g style={{ opacity: locked ? 0.45 : 1 }}>
        <circle cx={x} cy={y} r={r + 2} className="fill-cream-card" />
        <circle cx={x} cy={y} r={r} className={tierClass} />
        <text
          x={x}
          y={y + r + 11}
          textAnchor="middle"
          className="fill-ink text-[9px] font-medium"
        >
          {truncate(skill.name.toLowerCase(), 10)}
        </text>
      </g>
    </Link>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function SkillRow({ skill, mastery }: { skill: SkillNode; mastery: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(mastery * 100)));
  const tier = tierLabelFor(pct);
  return (
    <li>
      <Link
        href={`/drill/${skill.id}?from=/progress`}
        className="flex items-center gap-3 rounded-2xl bg-cream-card px-4 py-3 ring-1 ring-cream-deep/60 active:scale-[0.99]"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-ink">
            {skill.name.toLowerCase()}
          </div>
          <div className="text-[10px] uppercase tracking-[0.15em] text-ink-muted">
            {tier}
          </div>
        </div>
        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-ink/10">
          <div
            className={`h-full ${tierBarFor(pct)}`}
            style={{ width: `${pct}%` }}
            aria-hidden
          />
        </div>
        <div className="w-9 text-right text-xs font-semibold tabular-nums text-ink">
          {pct}%
        </div>
      </Link>
    </li>
  );
}
