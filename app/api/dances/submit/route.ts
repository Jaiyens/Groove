// POST /api/dances/submit
// body: { tiktok_url: string }
// Validates the URL, inserts a row with status='queued', returns { id }.
// Rate-limit: 1 submission per session per minute (best-effort via cookie).

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { isLikelyTikTokUrl } from '@/lib/tiktok/embed';
import { cookies } from 'next/headers';
import { randomUUID } from 'crypto';

export const dynamic = 'force-dynamic';

const SESSION_COOKIE = 'groove_sid';
const RATE_LIMIT_WINDOW_MS = 60_000;

const recentBySession = new Map<string, number>();

export async function POST(request: Request) {
  const supabase = getServerSupabase();
  if (!supabase) {
    return NextResponse.json(
      { error: 'Backend not configured. See SETUP_TODO.md.' },
      { status: 503 },
    );
  }

  let body: { tiktok_url?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const url = typeof body.tiktok_url === 'string' ? body.tiktok_url.trim() : '';
  if (!url) {
    return NextResponse.json({ error: 'tiktok_url is required' }, { status: 400 });
  }
  if (!isLikelyTikTokUrl(url)) {
    return NextResponse.json(
      { error: 'That doesn’t look like a TikTok URL.' },
      { status: 400 },
    );
  }

  const cookieJar = cookies();
  let sessionId = cookieJar.get(SESSION_COOKIE)?.value;
  if (!sessionId) sessionId = randomUUID();

  const last = recentBySession.get(sessionId) ?? 0;
  if (Date.now() - last < RATE_LIMIT_WINDOW_MS) {
    return NextResponse.json(
      { error: 'one submission per minute, please' },
      { status: 429 },
    );
  }

  // If the URL was already submitted (by anyone), return the existing row's id
  // rather than re-queueing. The worker dedupes by tiktok_url unique constraint.
  const existing = await supabase
    .from('dances')
    .select('id, status')
    .eq('tiktok_url', url)
    .maybeSingle();

  let id: string;
  if (existing.data?.id) {
    id = existing.data.id;
  } else {
    const insert = await supabase
      .from('dances')
      .insert({
        tiktok_url: url,
        status: 'queued',
        submitted_by_session_id: sessionId,
      })
      .select('id')
      .single();
    if (insert.error || !insert.data) {
      return NextResponse.json(
        { error: insert.error?.message ?? 'failed to insert' },
        { status: 500 },
      );
    }
    id = insert.data.id;
  }

  recentBySession.set(sessionId, Date.now());

  const response = NextResponse.json({ id });
  response.cookies.set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 365,
  });
  return response;
}
