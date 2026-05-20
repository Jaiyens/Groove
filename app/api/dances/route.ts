// GET /api/dances — paginated library of READY dances, sorted by view_count desc.
// Query params:
//   ?limit=50           page size (default 50, max 100)
//   ?offset=0           page offset
//   ?seed=true          only return seeded dances (those with NULL session id)

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
      'id, title, creator_handle, thumbnail_url, duration_seconds, view_count, ready_at',
    )
    .eq('status', 'ready')
    .order('view_count', { ascending: false })
    .order('ready_at', { ascending: false })
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
