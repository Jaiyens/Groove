-- Adds the original (non-skeleton) TikTok video URL. Mode A is being
-- redesigned around the actual TikTok video as the reference; the prior
-- `skeleton_video_url` becomes an opt-in overlay rather than the primary
-- reference media. Idempotent.

alter table dances
  add column if not exists video_url text;
