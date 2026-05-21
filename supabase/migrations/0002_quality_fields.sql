-- Adds the two day-3 fields that landed after the initial 0001_init.sql
-- was applied to some early users' databases. Safe to re-run (idempotent).

alter table dances
  add column if not exists low_quality boolean not null default false;

alter table dances
  add column if not exists audio_start_offset_ms int not null default 0;
