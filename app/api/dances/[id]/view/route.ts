// POST /api/dances/:id/view — increment view_count. Best-effort, fire-and-forget.

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function POST(_request: Request, ctx: { params: { id: string } }) {
  const supabase = getServerSupabase();
  if (!supabase) return NextResponse.json({ ok: true });

  const { id } = ctx.params;
  // RPC would be cleaner but keeps the API surface small to avoid extra
  // migration. Two-step read+write race here is acceptable for a view counter.
  const current = await supabase
    .from('dances')
    .select('view_count, status')
    .eq('id', id)
    .maybeSingle();
  if (current.error || !current.data) {
    return NextResponse.json({ ok: false }, { status: 404 });
  }
  if (current.data.status !== 'ready') {
    return NextResponse.json({ ok: true });
  }
  await supabase
    .from('dances')
    .update({ view_count: (current.data.view_count ?? 0) + 1 })
    .eq('id', id);
  return NextResponse.json({ ok: true });
}
