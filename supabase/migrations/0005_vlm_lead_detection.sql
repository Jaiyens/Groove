-- spec.md round-5 §Fix 5: VLM-driven lead-dancer detection.
-- We store the VLM's confidence + reasoning alongside the chosen
-- auto_selected_person_id so the picker UI can show the recommendation
-- as "✨ our guess" with a short explanation. Both columns are nullable
-- — null means the VLM was not consulted (single-dancer clip) or fell
-- through to the heuristic safety net.
alter table dances add column if not exists vlm_confidence text;
alter table dances add column if not exists vlm_reasoning text;
