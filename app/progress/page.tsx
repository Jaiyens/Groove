'use client';

// Skills tab — view-only mastery map.
//
// Reads the knowledge graph + per-skill mastery from the graph context
// and renders one row per non-routine skill, grouped by category. Each
// row is tappable and routes to /drill/<id>?from=/progress so the user
// can self-direct practice without being told they have to.
//
// Intentionally NOT a tree or a checklist: no layer labels, no locked
// gates, no recommended-next callout. The point is a personal index,
// not a curriculum.

import Link from 'next/link';
import { useMemo } from 'react';
import CreamBottomNav from '@/components/library/CreamBottomNav';
import { tierBarFor, tierLabelFor } from '@/components/results/tier';
import { useGraph } from '@/lib/graph/context';
import type { SkillCategory, SkillNode } from '@/lib/graph/types';

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

export default function SkillsPage() {
  const { graph, mastery } = useGraph();

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
      </header>

      <div className="flex-1 overflow-y-auto px-6 pb-6">
        {!grouped ? (
          <p className="mt-12 text-center text-sm text-ink-muted">loading…</p>
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
