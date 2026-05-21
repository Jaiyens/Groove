// POST /api/dances/:id/dancer
// body: { person_id: string }
// Updates dances.auto_selected_person_id when the user picks a dancer on
// the pick-dancer screen. Idempotent; safe to call multiple times.

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, ctx: { params: { id: string } }) {
  const supabase = getServerSupabase();
  if (!supabase) {
    return NextResponse.json(
      { error: 'Backend not configured.' },
      { status: 503 },
    );
  }
  let body: { person_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const personId =
    typeof body.person_id === 'string' ? body.person_id.trim() : '';
  if (!personId) {
    return NextResponse.json({ error: 'person_id required' }, { status: 400 });
  }
  const { error } = await supabase
    .from('dances')
    .update({
      auto_selected_person_id: personId,
      // Once the user has explicitly chosen, don't prompt again.
      requires_dancer_pick: false,
    })
    .eq('id', ctx.params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, person_id: personId });
}
