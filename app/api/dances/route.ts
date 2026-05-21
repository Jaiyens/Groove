// GET /api/dances — paginated library of READY dances, sorted by created_at desc.
// Query params:
//   ?limit=50           page size (default 50, max 100)
//   ?offset=0           page offset
//   ?seed=true          only return seeded dances (those with NULL session id)
//
// SPECK polish §Fix 5: sort is `created_at DESC` (newest first) and is
// deliberately NOT usage-based. The old `view_count DESC` sort made the
// library feel like it was learning from the user when it wasn't —
// `bumpView` increments on every visit, so the dance the user opened
// last would creep to the top, looking like an opaque "for you" ranking.
// Usage-based / personalized sort is deferred (see DECISIONS.md).

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import type { DanceListItem } from '@/lib/dances/types';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const supabase = getServerSupabase();
  if (!supabase) {
    return NextResponse.json({ dances: [], unconfigured: true }, { status: 200 });
  }

  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  const seedOnly = url.searchParams.get('seed') === 'true';

  let query = supabase
    .from('dances')
    .select(
      'id, title, display_name, creator_handle, thumbnail_url, video_url, duration_seconds, view_count, ready_at, created_at',
    )
    .eq('status', 'ready')
    // SPECK polish §Fix 5: newest first, deterministic. `id` tiebreaks
    // when two rows share a created_at down to the millisecond.
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1);

  if (seedOnly) {
    query = query.is('submitted_by_session_id', null);
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ dances: (data ?? []) as DanceListItem[] });
}
