-- Groove v2 — initial schema
-- Run once against a fresh Supabase project: open SQL Editor in the
-- dashboard, paste, run. Or `supabase db push` after `supabase login`.

create extension if not exists "pgcrypto";

create table if not exists dances (
  id uuid primary key default gen_random_uuid(),
  tiktok_url text unique not null,
  title text,
  creator_handle text,
  duration_seconds float,
  bpm float,
  status text not null check (status in ('queued', 'processing', 'ready', 'failed')),
  error_message text,
  thumbnail_url text,
  pose_data_url text,
  skeleton_video_url text,
  audio_url text,
  chunks_json jsonb,
  required_skills jsonb,
  skill_weights jsonb,
  submitted_by_session_id text,
  view_count int not null default 0,
  low_quality boolean not null default false,
  audio_start_offset_ms int not null default 0,
  created_at timestamptz not null default now(),
  ready_at timestamptz
);

create index if not exists dances_ready_view_count_idx
  on dances(status, view_count desc)
  where status = 'ready';

create index if not exists dances_status_idx on dances(status);

-- RLS: the anon key is allowed to read ready dances and insert new submissions.
-- The service role (used by the worker) bypasses RLS entirely.
alter table dances enable row level security;

drop policy if exists dances_read_ready on dances;
create policy dances_read_ready on dances
  for select
  to anon, authenticated
  using (status = 'ready' or status = 'queued' or status = 'processing' or status = 'failed');

drop policy if exists dances_insert_anon on dances;
create policy dances_insert_anon on dances
  for insert
  to anon, authenticated
  with check (status = 'queued');

-- Anonymous users can bump the view_count on a ready dance.
drop policy if exists dances_update_view_count on dances;
create policy dances_update_view_count on dances
  for update
  to anon, authenticated
  using (status = 'ready')
  with check (status = 'ready');
