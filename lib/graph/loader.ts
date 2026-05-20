// Knowledge graph loader + Zod validator. Pure logic, runs in browser & node.
// Throws ZodError with clear path info on schema deviation so when the real
// graph drops in tomorrow, mismatches are obvious.

import { z } from 'zod';
import type {
  AnyNode,
  KnowledgeGraph,
  RoutineNode,
  SkillCategory,
  SkillNode,
} from './types';

const SkillCategoryEnum = z.enum([
  'foundation',
  'isolation',
  'travel',
  'combo',
  'vocabulary',
  'routine',
]) satisfies z.ZodType<SkillCategory>;

const SkillLayerEnum = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
]);

const BaseSkillNodeSchema = z.object({
  id: z.string().min(1, 'id must be non-empty'),
  name: z.string().min(1),
  layer: SkillLayerEnum,
  category: SkillCategoryEnum,
  description: z.string(),
  prerequisites: z.array(z.string()),
  measurable_success_criterion: z.string(),
  drill_description: z.string(),
  drill_duration_seconds: z.number().nonnegative(),
  mastery_threshold: z.string(),
  common_mistakes: z.array(z.string()),
  sources: z.array(z.string()),
});

const RoutineNodeSchema = BaseSkillNodeSchema.extend({
  layer: z.literal(6),
  category: z.literal('routine'),
  bpm: z.number().positive(),
  duration_seconds: z.number().positive(),
  required_skills: z.array(z.string()),
  skill_weights: z.record(z.string(), z.number().min(0).max(1)),
});

// A node is a RoutineNode iff its layer === 6 AND category === 'routine'.
// Otherwise it's a plain SkillNode. We use a discriminated check at the union
// to give clear error messages when the real graph arrives.
const NodeSchema: z.ZodType<AnyNode> = z.union([
  RoutineNodeSchema,
  BaseSkillNodeSchema.refine(
    (n) => !(n.layer === 6 && n.category === 'routine'),
    {
      message:
        'node with layer=6 and category="routine" must include bpm, duration_seconds, required_skills, skill_weights',
    },
  ),
]);

// The on-disk graph may be either of:
//   (a) a bare JSON array of nodes (production format from Claude Research)
//   (b) { nodes, version, generated_at } object (legacy / stub fixture format)
// Both are normalised to the same KnowledgeGraph shape.
const KnowledgeGraphObjectSchema = z.object({
  nodes: z.array(NodeSchema).min(1, 'knowledge graph must have at least one node'),
  version: z.string().optional(),
  generated_at: z.string().optional(),
});

export const KnowledgeGraphSchema = z.preprocess(
  (input) => {
    if (Array.isArray(input)) {
      return { nodes: input, version: 'unknown', generated_at: '' };
    }
    if (input && typeof input === 'object') {
      const obj = input as Record<string, unknown>;
      return {
        nodes: obj.nodes,
        version: typeof obj.version === 'string' ? obj.version : 'unknown',
        generated_at:
          typeof obj.generated_at === 'string' ? obj.generated_at : '',
      };
    }
    return input;
  },
  KnowledgeGraphObjectSchema,
);

export class GraphValidationError extends Error {
  constructor(public readonly cause: z.ZodError, message: string) {
    super(message);
    this.name = 'GraphValidationError';
  }
}

function formatZodError(err: z.ZodError): string {
  return err.errors
    .map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : '(root)';
      return `  • at ${path}: ${issue.message}`;
    })
    .join('\n');
}

export function validateGraph(input: unknown): KnowledgeGraph {
  const parsed = KnowledgeGraphSchema.safeParse(input);
  if (!parsed.success) {
    const detail = formatZodError(parsed.error);
    throw new GraphValidationError(
      parsed.error,
      `knowledge_graph.json failed schema validation:\n${detail}`,
    );
  }
  // Normalise: ensure version / generated_at always exist downstream.
  const normalized = {
    nodes: parsed.data.nodes,
    version: parsed.data.version ?? 'unknown',
    generated_at: parsed.data.generated_at ?? '',
  } as KnowledgeGraph;
  // Cross-reference check: every prerequisite + required_skill id must exist.
  const ids = new Set(normalized.nodes.map((n) => n.id));
  const issues: string[] = [];
  for (const node of normalized.nodes) {
    for (const prereq of node.prerequisites) {
      if (!ids.has(prereq)) {
        issues.push(`  • node "${node.id}" lists unknown prerequisite "${prereq}"`);
      }
    }
    if (isRoutineNodeShape(node)) {
      for (const req of node.required_skills) {
        if (!ids.has(req)) {
          issues.push(
            `  • routine "${node.id}" lists unknown required_skill "${req}"`,
          );
        }
      }
      for (const weighted of Object.keys(node.skill_weights)) {
        if (!node.required_skills.includes(weighted)) {
          issues.push(
            `  • routine "${node.id}" has skill_weight for "${weighted}" but it's not in required_skills`,
          );
        }
      }
    }
  }
  if (issues.length > 0) {
    throw new GraphValidationError(
      new z.ZodError([]),
      `knowledge_graph.json failed cross-reference validation:\n${issues.join('\n')}`,
    );
  }
  return normalized;
}

function isRoutineNodeShape(node: SkillNode | RoutineNode): node is RoutineNode {
  return node.layer === 6 && node.category === 'routine';
}

// Browser/server fetcher. Returns a validated KnowledgeGraph or throws.
export async function loadGraph(
  url = '/data/knowledge_graph.json',
): Promise<KnowledgeGraph> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`failed to load ${url}: ${res.status} ${res.statusText}`);
  }
  const json: unknown = await res.json();
  return validateGraph(json);
}
