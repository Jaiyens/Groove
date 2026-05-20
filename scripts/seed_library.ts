#!/usr/bin/env tsx
/* eslint-disable no-console */
//
// Seed the Groove library.
//
// Reads `seed_urls.txt` from the repo root (one URL per line, `#` for
// comments), POSTs each to /api/dances/submit, then polls until ready (or
// failed). Logs success / failure for each.
//
// Run:
//   npm run seed                       # uses http://localhost:3000
//   GROOVE_BASE_URL=… npm run seed     # custom host
//
// Requires the API to be running and the worker to be picking up queued rows.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const BASE_URL = process.env.GROOVE_BASE_URL ?? 'http://localhost:3000';
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60_000;

interface DanceRecord {
  id: string;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  title: string | null;
  error_message: string | null;
}

async function main() {
  const seedFile = resolve(process.cwd(), 'seed_urls.txt');
  let raw: string;
  try {
    raw = await readFile(seedFile, 'utf-8');
  } catch {
    console.error(`✗ seed_urls.txt not found at ${seedFile}`);
    console.error('  Create it with one TikTok URL per line (# starts a comment).');
    process.exit(1);
  }
  const urls = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  if (urls.length === 0) {
    console.error('✗ seed_urls.txt is empty');
    process.exit(1);
  }

  console.log(`Seeding ${urls.length} URL(s) via ${BASE_URL}`);
  console.log('');

  const results = { success: 0, failed: 0, skipped: 0 };

  for (let i = 0; i < urls.length; i += 1) {
    const url = urls[i];
    const tag = `[${i + 1}/${urls.length}]`;
    console.log(`${tag} → ${url}`);
    try {
      const id = await submit(url);
      console.log(`${tag}   queued as ${id}`);
      const final = await pollUntilReady(id);
      if (final.status === 'ready') {
        console.log(`${tag}   ready: ${final.title ?? '(no title)'}\n`);
        results.success += 1;
      } else {
        console.log(`${tag}   failed: ${final.error_message ?? 'unknown error'}\n`);
        results.failed += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`${tag}   skipped: ${message}\n`);
      results.skipped += 1;
    }
  }

  console.log('');
  console.log(`Summary: ${results.success} ready, ${results.failed} failed, ${results.skipped} skipped`);
  process.exit(results.failed + results.skipped > 0 ? 2 : 0);
}

async function submit(url: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/dances/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tiktok_url: url }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `submit failed: ${res.status}`);
  }
  const json = (await res.json()) as { id: string };
  return json.id;
}

async function pollUntilReady(id: string): Promise<DanceRecord> {
  const start = Date.now();
  for (;;) {
    const res = await fetch(`${BASE_URL}/api/dances/${id}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`fetch dance ${id}: ${res.status}`);
    const record = (await res.json()) as DanceRecord;
    if (record.status === 'ready' || record.status === 'failed') return record;
    if (Date.now() - start > POLL_TIMEOUT_MS) {
      throw new Error('polling timed out');
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
