# spec.md — Five fixes: dead button, redundant countdown, dual skeleton, Mode B framing, three-layer lead detection

## Read before starting

Read RUNTIME_VERIFICATION.md, DECISIONS.md, and the latest BLOCKERS.md. The previous round (commit `122a28c`) shipped the hands-free upper-body framing gate. Phone testing exposed five new issues. This round fixes them. No rewrites — targeted patches per issue.

## Issues — implementation order matters

### Fix 1: "I got it · test" button does nothing — dead navigation in Mode A

User reports: in Mode A, tapping the "I got it · test" CTA at the bottom of the screen does not navigate to Mode B. The button is being rendered but its onClick handler is either missing, throwing, or routing to a path that doesn't exist.

**Diagnosis steps:**
1. Open `app/dance/[danceId]/chunk/[chunkIndex]/copy/page.tsx`.
2. Find the "I got it · test" button. Check its onClick handler.
3. Most likely cause (educated guess): the router push uses a path like `/dance/${dance.id}/chunk/${chunkIndex}/test` but either (a) the route file doesn't exist at `app/dance/[danceId]/chunk/[chunkIndex]/test/page.tsx`, (b) a guard or middleware is blocking the navigation, or (c) the handler is wrapped in something that swallows the click. Verify each.
4. Run the dev server, open the page, tap the button, and check the browser console for errors.

**Fix:** make the button reliably navigate to Mode B. If the test route file genuinely doesn't exist, create it — it should be a near-clone of Mode A but in "scoring" mode with the StartOverlay enabled. Add a unit/E2E test verifying the button click navigates.

Acceptance: tapping "I got it · test" in Mode A immediately routes to `/dance/[id]/chunk/[i]/test`, the StartOverlay appears, tap start → 3-2-1 → scoring begins.

### Fix 2: Redundant countdown — framing gate → Mode A pre-start overlay → ANOTHER countdown

Current flow when user taps a single-dancer or already-resolved dance:
1. `/onboarding/frame-check` shows silhouette → 1.5s arm → 5-4-3-2-1-GO → screen dismisses
2. User lands on `/dance/[id]/chunk/[i]/copy` (Mode A)
3. Mode A still shows the OLD StartOverlay component from Round 4 Fix 2: "start" CTA button → tap → 3-2-1 countdown → THEN video plays

The user is already 4-5 feet away after step 1. They can't reach the phone to tap "start" without walking back. The second countdown is redundant.

**Fix:**
- On framing-check completion, before navigating to the next route, set `sessionStorage['framing_gate_just_fired'] = Date.now().toString()`.
- On Mode A mount (`/dance/[id]/chunk/[i]/copy`), read that key. If present and timestamp is within the last 5000ms, skip the StartOverlay entirely, auto-play the video and start camera, then clear the key.
- If absent or stale (>5s old), keep the existing StartOverlay + 3-2-1 countdown as a safety net for users who navigated to Mode A directly (browser back, history, deep link).
- Mode B (`/dance/[id]/chunk/[i]/test`) keeps its existing StartOverlay unchanged. Mode B is normally reached by tapping "I got it · test" from Mode A; the user has been watching the screen and may not be in dance position, so a countdown is appropriate there.

### Fix 3: Skeleton overlay should appear on BOTH the user and the reference dancer

Currently when the user taps the "skeleton" toggle in Mode A, the skeleton is shown only on one side (probably just the reference video). The user wants the skeleton on both sides simultaneously: the user's own video AND the reference video.

**Fix in Mode A (`app/dance/[danceId]/chunk/[chunkIndex]/copy/page.tsx`):**
- The skeleton toggle should affect BOTH overlays: one over the REF panel (drawn from the worker-extracted pose track of the auto-selected lead dancer) and one over the YOU panel (drawn from the live MediaPipe pose extraction running on the user's camera feed).
- Both overlays should use the same skeleton drawing function — likely `lib/pose/drawSkeleton.ts` or equivalent. Same color, same line thickness, same joint set (use the upper-body 15-landmark set from `lib/pose/framingCheck.ts` if the dance is upper-body, otherwise the full set).
- The skeleton on the REF side is drawn from precomputed pose JSON keyed to video timestamp. The skeleton on the YOU side is drawn from real-time MediaPipe output. Both should sync visually with their respective video sources.
- Apply the same change to Mode B if the skeleton toggle exists there.

Acceptance: in Mode A, toggling "skeleton" on shows a skeleton on the reference dancer AND a skeleton on the user's own camera feed simultaneously, both moving in sync with their respective videos.

### Fix 4: Mode B mid-session framing toast still uses full-body landmarks

The onboarding gate at `/onboarding/frame-check` correctly uses 15 upper-body landmarks (no ankles) via `isUpperBodyFramed()` from `lib/pose/framingCheck.ts`. But the mid-session "step back so we can see all of you" toast in Mode B still uses the full 17-landmark check, so it triggers when ankles are out of frame even though upper-body dances don't need them.

**Fix:**
- In the Mode B framing-check logic, replace the full-body check with `isUpperBodyFramed()`.
- Toast text changes to: "step back so we can see your upper body".
- Trigger condition unchanged: confidence < 0.5 for >1.5s, but on the upper-body landmark set.
- Toast remains informational — does NOT block scoring, does NOT pause video.
- Scoring layer continues consuming all detected landmarks. We're only changing the toast's trigger condition.

### Fix 5: Lead-dancer detection — three-layer system (VLM primary + picker fallback + heuristic safety net)

This is the architecturally big change in this round.

**Background context (read this fully before implementing):**

The current geometric `lead_score` formula (centrality + size + forwardness + persistence) breaks down on videos like `@hearts2miraaa` where 3 dancers stand shoulder-to-shoulder at the same camera depth. All four signals become noise-level. The algorithm picks essentially randomly but reports high confidence, so the picker doesn't trigger, and the wrong dancer is selected.

Research conclusion: "main dancer detection" is an open problem in computer vision research, not a solved one. The only reliable approach is to use a Vision-Language Model (VLM) to look at the actual visual content and reason about who the lead is. Gemini 2.5 Flash with thinking disabled runs at ~$0.002 per image, which is negligible at our ingest scale.

**Layer 1 — VLM as primary detector:**

In `worker/pose.py` (or a new file `worker/lead_detector.py` if cleaner), add a function `detect_lead_dancer_vlm(opening_frame_image, person_tracks)` that:

1. Takes the OPENING FRAME of the video (or specifically, the frame at the 0.5–1.0s mark — past any TikTok title cards but before significant motion). Use the BoT-SORT tracks to draw labeled numbered bounding boxes (P1, P2, P3, ...) around each detected person.
2. Sends the annotated image to Gemini 2.5 Flash via the Google Generative AI Python SDK.
3. Uses this prompt:
   ```
   This is a frame from a TikTok dance video. The numbered boxes (P1, P2, P3, ...) mark each person detected. Identify which numbered person is the LEAD or MAIN dancer — the one the camera is framed around, who initiates moves, or who appears central to the choreography. Consider:
   - Who is most centered in the frame
   - Who appears closest to the camera
   - Whose body language suggests they're leading (e.g., facing the camera directly, standing slightly forward)
   - The TikTok username is @{username} — they posted the video, so they are likely the lead

   Respond ONLY with a JSON object: {"lead_person_id": "P1", "confidence": "high|medium|low", "reasoning": "short explanation"}
   ```
4. Parse the JSON response. Match `lead_person_id` back to the corresponding BoT-SORT track ID.
5. Store the VLM's chosen track in `dances.auto_selected_person_id` and the VLM's confidence in a new column `dances.vlm_confidence`.
6. Log the VLM's reasoning to the dance record for debugging (column `dances.vlm_reasoning`).

**Implementation details:**
- Add `google-generativeai` to `worker/requirements.txt`.
- Environment variable: `GEMINI_API_KEY` — add to `.env.example` and document in SETUP.md.
- Use `gemini-2.5-flash` with thinking disabled to minimize cost: pass `generationConfig={"thinkingConfig": {"thinkingBudget": 0}}` if the SDK supports it; otherwise use the default and live with the small extra cost.
- Image annotation: use Pillow to draw rectangle + numbered label "P1", "P2", "P3" on a copy of the opening frame. Save the annotated frame to `worker/debug/` for inspection during dev. Color the boxes high-contrast (red outline, white text on black background).
- Wrap the Gemini API call in a try/except. If it fails for any reason (network, rate limit, API key missing, parsing error), log the failure and fall through to Layer 3 (heuristic).

**Layer 2 — Picker as fallback:**

Update the picker-trigger logic in `worker/pose.py`:

- If `dancer_count == 1`: no picker needed, no VLM needed.
- If `dancer_count >= 2`:
  - Run VLM (Layer 1) first.
  - If VLM returns confidence == "high": auto-select that person, set `requires_dancer_pick = false`.
  - If VLM returns confidence == "medium" or "low": auto-select that person but set `requires_dancer_pick = true` so the picker still appears as a confirmation step (with the VLM's choice pre-highlighted).
  - If VLM call failed entirely: fall through to Layer 3.
- Edge case: if `dancer_count >= 3`, force `requires_dancer_pick = true` regardless of VLM confidence. With 3+ dancers, the user should always get to see and confirm. Pre-highlight the VLM's choice if available.

The picker UI at `/dance/[id]/pick-dancer` should be updated to:
- Show a small "✨ our guess" badge on the VLM-recommended dancer's thumbnail.
- Below the thumbnails, show the VLM's reasoning in small text (e.g., "we think it's P2 because they're centered and facing the camera directly").
- Keep the existing "pick one" interaction unchanged.

**Layer 3 — Heuristic as deterministic safety net:**

When the VLM is unavailable (no API key, network down, API error, response parse failure), fall back to a stronger geometric heuristic. Replace the current 4-factor `lead_score` with a stronger formula emphasizing opening-frame centrality:

```
opening_centrality = average of (1 - |bbox_center_x - frame_center_x| / (frame_width / 2)) over frames 15-45 (the opening 0.5-1.5s window assuming 30fps)
lead_score = 0.5 * opening_centrality
           + 0.2 * size_avg
           + 0.15 * forwardness_avg
           + 0.15 * persistence
```

Tracks not present in the opening window get `opening_centrality = 0`.

When falling back to Layer 3:
- Set `dances.vlm_confidence = null` and `dances.vlm_reasoning = "VLM unavailable, used heuristic fallback"`.
- Always set `requires_dancer_pick = true` if `dancer_count >= 2`, regardless of geometric confidence gap.

**Schema additions (write a migration):**

```sql
alter table dances add column if not exists vlm_confidence text;
alter table dances add column if not exists vlm_reasoning text;
```

**Reprocess after deployment:**

After Fix 5 lands, run `worker/reprocess_all.py` to regenerate pose data + lead detection for all existing dances. This is mandatory — existing rows have stale `auto_selected_person_id` values from the old geometric formula. Verify on `@hearts2miraaa` that the new auto-selected person is the girl in white in the middle, not the rightmost dancer.

## Order of implementation

Do these in this exact order. Each one should be a separate commit.

1. **Fix 1 (dead "I got it" button)** — highest priority, totally blocking the practice loop. Commit message: `fix: I got it test button now navigates to Mode B`.

2. **Fix 2 (redundant countdown)** — frontend only, low risk, big UX win. Commit message: `fix: skip Mode A start overlay when framing gate just fired`.

3. **Fix 3 (dual skeleton overlay)** — frontend only, moderate refactor of the skeleton drawing logic. Commit message: `feat: skeleton overlay shown on both REF and YOU panels in Mode A`.

4. **Fix 4 (Mode B upper-body framing)** — small refactor reusing `isUpperBodyFramed()`. Commit message: `fix: Mode B framing toast uses upper-body landmark set`.

5. **Fix 5 (three-layer lead detection)** — biggest change, do last so the smaller fixes are independently reviewable. Two commits:
   - `feat: add Gemini VLM as primary lead-dancer detector with heuristic fallback`
   - `feat: picker UI shows VLM recommendation badge and reasoning`

   Then run `worker/reprocess_all.py` and document the before/after `auto_selected_person_id` for `@hearts2miraaa` in the commit log.

## Acceptance test

After all fixes ship, do this full end-to-end test:

1. Clear localStorage on test browser.
2. Tap `@hearts2miraaa` from the library.
3. Land on `/onboarding/frame-check`. Silhouette is upper-body only.
4. Step back to knees-up framing → 1.5s arm → 5-4-3-2-1-GO with audible ticks.
5. Screen dismisses. Since `@hearts2miraaa` has 3 dancers, land on `/dance/[id]/pick-dancer`.
6. **The girl in the white top in the middle should have the "✨ our guess" badge.** ✓ Fix 5 working.
7. Tap her thumbnail → land on Mode A.
8. **Mode A video auto-plays immediately. No start button. No second 3-2-1.** ✓ Fix 2 working.
9. **The skeleton on the REF video should be on the GIRL IN THE WHITE TOP IN THE MIDDLE.** ✓ Fix 5 deeper validation.
10. Toggle the "skeleton" button → **skeletons appear on BOTH the user and the reference dancer.** ✓ Fix 3 working.
11. Sit at knees-up distance, ankles out of frame → no mid-session toast triggers. ✓ Fix 4 working.
12. Tap "I got it · test" → **navigates to Mode B.** ✓ Fix 1 working.
13. Mode B shows StartOverlay → tap start → 3-2-1 countdown → scoring begins.
14. Tap `@hearts2miraaa` again next session → bypasses framing-check (localStorage flag set) → goes straight through to whatever the user previously selected.

## What NOT to change

- The framing gate state machine in `lib/pose/framingCheck.ts` — works correctly.
- The BoT-SORT tracker itself — only the lead-detection layer changes.
- The duet visual layout — done.
- The existing pick-a-dancer screen layout — only ADD the VLM badge and reasoning text.
- The DTW scoring math layer — untouched.

## Hard rules

1. One commit per fix as listed above. No mega-commits.
2. `GEMINI_API_KEY` must be documented in SETUP.md and `.env.example`. Worker must fail gracefully if it's missing (fall through to heuristic Layer 3, not crash).
3. Cost guardrail: log every Gemini API call with token count and dance ID to `worker/logs/vlm_calls.log` so we can audit spend.
4. Run `worker/reprocess_all.py` after Fix 5 lands. Mandatory. The acceptance test will fail without it because production data still reflects old logic.
5. The picker should always trigger for 3+ dancers, even when VLM confidence is "high". This is an intentional safety policy.
6. Update RUNTIME_VERIFICATION.md with the new state after all five fixes.

Begin.