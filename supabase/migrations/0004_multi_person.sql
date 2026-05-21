-- Phase 3 (multi-person dance support): adds the per-dance dancer
-- metadata the worker now produces. Idempotent.

alter table dances add column if not exists dancer_count int default 1;
alter table dances add column if not exists auto_selected_person_id text;
alter table dances add column if not exists person_thumbnails jsonb;
alter table dances add column if not exists requires_dancer_pick boolean default false;
