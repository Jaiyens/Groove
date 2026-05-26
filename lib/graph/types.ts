// Knowledge graph schema. Matches spec exactly so the real graph from Claude
// Research drops in without code changes.

export type SkillCategory =
  | 'foundation'
  | 'isolation'
  | 'travel'
  | 'combo'
  | 'vocabulary'
  | 'routine';

export type SkillLayer = 1 | 2 | 3 | 4 | 5 | 6;

// Optional per-skill override for the Gemini-axis → per-skill projection
// matrix. Use when category defaults don't fit a specific skill (e.g.
// chest isolation needs more `timing` weight than the isolation default).
export interface AxisWeights {
  timing: number;
  shape: number;
  energy: number;
  flow: number;
}

export interface SkillNode {
  id: string;
  name: string;
  layer: SkillLayer;
  category: SkillCategory;
  description: string;
  prerequisites: string[];
  measurable_success_criterion: string;
  drill_description: string;
  drill_duration_seconds: number;
  mastery_threshold: string;
  common_mistakes: string[];
  sources: string[];
  axis_weights?: AxisWeights;
}

export interface RoutineNode extends SkillNode {
  layer: 6;
  category: 'routine';
  bpm: number;
  duration_seconds: number;
  required_skills: string[];
  skill_weights: Record<string, number>;
}

export type AnyNode = SkillNode | RoutineNode;

export type KnowledgeGraph = {
  nodes: AnyNode[];
  version: string;
  generated_at: string;
};

export function isRoutineNode(node: AnyNode): node is RoutineNode {
  return node.layer === 6 && node.category === 'routine';
}
