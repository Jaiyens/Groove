// GET /api/dances/:id — returns the full dance record including status.
// Used by the submit polling loop and by the dance learning routes.

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import type { DanceRecord } from '@/lib/dances/types';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, ctx: { params: { id: string } }) {
  const supabase = getServerSupabase();
  if (!supabase) {
    return NextResponse.json(
      { error: 'Backend not configured. See SETUP_TODO.md.' },
      { status: 503 },
    );
  }
  const { id } = ctx.params;
  const { data, error } = await supabase
    .from('dances')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(data as DanceRecord);
}
