// Smoke test for scoreDanceAttempt.
// Usage: tsx scripts/smoke_score_attempt.ts <reference.mp4> <attempt.mp4>

// tsx doesn't auto-load .env.local the way Next does. Parse it ourselves
// before importing the scoring module (which reads AI_GATEWAY_API_KEY).
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const envPath = resolve(process.cwd(), '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, rawValue] = m;
    if (process.env[key]) continue;
    const value = rawValue.replace(/^['"]|['"]$/g, '');
    process.env[key] = value;
  }
}

const { scoreDanceAttempt } = await import('../lib/scoring/gemini/score-attempt');

async function main() {
  const [referencePath, attemptPath] = process.argv.slice(2);
  if (!referencePath || !attemptPath) {
    console.error('Usage: tsx scripts/smoke_score_attempt.ts <reference.mp4> <attempt.mp4>');
    process.exit(1);
  }

  console.log(`Scoring:\n  reference: ${referencePath}\n  attempt:   ${attemptPath}\n`);
  const t0 = Date.now();
  const result = await scoreDanceAttempt(referencePath, attemptPath);
  const ms = Date.now() - t0;

  console.log(`\n--- Result (${ms}ms) ---`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('\n--- Failed ---');
  console.error(err);
  process.exit(1);
});
