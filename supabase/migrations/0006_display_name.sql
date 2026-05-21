-- SPECK polish §Fix 3: AI-generated dance names.
--
-- `display_name` is what the library shows. `title` is preserved as the raw
-- TikTok caption (useful for debugging, regex bake-offs, and the rare case
-- the caption is actually a clean song title we can promote back later).

alter table dances add column if not exists display_name text;
