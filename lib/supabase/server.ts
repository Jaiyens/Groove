// Server-only Supabase client. Uses the service role key.
// MUST NEVER be imported into client components.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null | undefined;

export function getServerSupabase(): SupabaseClient | null {
  if (cached !== undefined) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    cached = null;
    return null;
  }
  cached = createClient(normaliseUrl(url), key, {
    auth: { persistSession: false, autoRefreshToken: false },
    // Next.js wraps fetch and caches by default; force no-store so reads
    // always hit Supabase. Polling routes (/api/dances/:id during ingest)
    // were returning stale `processing` after the row had flipped to ready.
    global: {
      fetch: ((url: RequestInfo | URL, init?: RequestInit) =>
        fetch(url, { ...init, cache: 'no-store' })) as typeof fetch,
    },
  });
  return cached;
}

function normaliseUrl(raw: string): string {
  let url = raw.trim().replace(/\/$/, '');
  for (const suffix of ['/rest/v1', '/rest']) {
    if (url.endsWith(suffix)) url = url.slice(0, -suffix.length);
  }
  return url;
}
