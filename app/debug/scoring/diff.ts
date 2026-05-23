// SPECK overnight Track 2 §debug-scoring: pure helpers shared by the
// debug page and its smoke tests. Kept out of `page.tsx` so they are
// importable from node's test runner without dragging in React.

export type ScalarDiff = {
  key: string;
  before: unknown;
  after: unknown;
  changed: boolean;
};

const SCALAR_KEYS_OF_INTEREST = [
  'is_actually_dancing',
  'tier',
  'overall_score',
  'timing',
  'body_isolation',
  'shape_accuracy',
  'transitions',
  'energy_commitment',
  'displayedOverall',
];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Pluck values for the keys we care about from either the raw Gemini
// response or the wrapping API response (which has `{ score, latencyMs }`).
// Returns null for keys not present. Recurses one level into a `score`
// child so callers can pass the raw API JSON without unwrapping first.
export function extractScalarKeys(payload: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isObject(payload)) return out;
  const score = isObject(payload.score) ? (payload.score as Record<string, unknown>) : payload;
  for (const k of SCALAR_KEYS_OF_INTEREST) {
    if (k in score) out[k] = score[k];
    else if (isObject(score.components) && k in score.components) out[k] = score.components[k];
  }
  return out;
}

// Build a per-key diff between two payloads. `changed` is true when the
// key exists in either side and the values are not strictly equal.
export function diffScalarKeys(before: unknown, after: unknown): ScalarDiff[] {
  const a = extractScalarKeys(before);
  const b = extractScalarKeys(after);
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  const rows: ScalarDiff[] = [];
  for (const key of keys) {
    const lhs = key in a ? a[key] : undefined;
    const rhs = key in b ? b[key] : undefined;
    rows.push({ key, before: lhs, after: rhs, changed: !Object.is(lhs, rhs) });
  }
  // Stable order: keys-of-interest first, then any extras alphabetically.
  rows.sort((x, y) => {
    const xi = SCALAR_KEYS_OF_INTEREST.indexOf(x.key);
    const yi = SCALAR_KEYS_OF_INTEREST.indexOf(y.key);
    if (xi !== -1 && yi !== -1) return xi - yi;
    if (xi !== -1) return -1;
    if (yi !== -1) return 1;
    return x.key < y.key ? -1 : x.key > y.key ? 1 : 0;
  });
  return rows;
}

// Cheap helper: format an unknown for display in a single cell. Strings
// stay strings; numbers/booleans become strings; objects render as
// '<obj>' so the cell never wraps surprisingly. The full JSON tab is
// where the user goes if they want the whole structure.
export function formatCell(v: unknown): string {
  if (v === undefined) return '—';
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '<obj>';
}
