// Browser-safe Supabase client. Uses the anon key.
// Returns `null` when env vars are missing so calling code can degrade
// gracefully (the empty-state UI takes over).

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null | undefined;

export function getBrowserSupabase(): SupabaseClient | null {
  if (cached !== undefined) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    cached = null;
    return null;
  }
  cached = createClient(normaliseUrl(url), key, {
    auth: { persistSession: false },
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

export function hasSupabaseConfig(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}
