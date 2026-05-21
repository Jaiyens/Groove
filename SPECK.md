# spec.md — Polish round: dead test button, mirroring, AI naming, library polish, wordmark restyle, library sort, preview-on-tap, Mode B UI audit

## Read before starting

Read RUNTIME_VERIFICATION.md, DECISIONS.md, and the latest BLOCKERS.md. The previous round shipped the three-layer lead detection (VLM + picker + heuristic) and dual skeleton overlay. Real-phone testing on the latest deploy revealed a set of polish issues and one critical bug. This round handles them. Targeted fixes — no rewrites.

## Issues — implementation order matters

### Fix 1: Dead "start" button on the Mode B test page

User reports: after tapping "I got it · test" in Mode A, the user lands on the Mode B test page. The page shows "test · chunk 1/3" at the top. There IS a "start" button rendered. Tapping it produces no response — the page appears to hang on a loading state and the scoring loop never begins.

**Diagnosis steps:**
1. Open `app/dance/[danceId]/chunk/[chunkIndex]/test/page.tsx` (or wherever the Mode B route lives).
2. Find the StartOverlay's "start" button. Check its onClick handler.
3. Most likely causes (in order of probability):
   - The handler is awaiting an async camera-init or pose-extractor-init promise that never resolves on this route (Mode A may have already initialized them, and Mode B's init code conflicts or hangs).
   - The countdown state machine starts but the "GO" callback never fires because of a stale closure or missing dependency in a useEffect.
   - The handler routes through a redirect that's blocked by a guard.
4. Add a `console.log("[mode-b] start tapped")` at the top of the handler, run the dev server, tap the button, and watch the console + network panel. The log + any errors will narrow it down within minutes.

**Fix:** make the button reliably begin the Mode B countdown and scoring. After the 3-2-1-GO countdown completes, the scored test session must start: camera feed live, pose detection running, score accumulating. Add an E2E test that exercises this path.

Acceptance: tapping "start" on the Mode B test page triggers the 3-2-1-GO countdown with audible ticks, then the scoring session begins with the user's pose being matched against the reference. At the end of the chunk, a score appears.

### Fix 2: Mirror the reference video horizontally (default ON)

User reports: when copying the reference dancer's moves, the directions feel reversed. The dancer's left hand appears on the user's right side of the screen, so when the user copies what they see, they're physically going the wrong direction. This is the "mirror mode" problem — standard issue in every dance learning context.

**Fix:**
- In Mode A (`copy/page.tsx`) and Mode B (`test/page.tsx`), apply `transform: scaleX(-1)` to the REF video element by default.
- Add a "mirror" toggle button to the controls bar (near the existing 50%/75%/100% speed + skeleton toggle). Icon: a simple ↔ or flip-horizontal symbol.
- Mirror state should persist in localStorage as `groov_mirror_enabled` (default `true`).
- When the toggle is ON, the REF video is flipped horizontally so the dancer's left = the user's left.
- IMPORTANT: when the REF video is mirrored, the pre-extracted skeleton overlay on the REF panel must also be mirrored to stay aligned with the video. Apply the same transform to the skeleton canvas. The YOU panel is unaffected.
- The scoring layer is NOT affected — pose comparison happens in joint-angle space which is mirroring-invariant by construction. (If joint-angle DTW is somehow mirror-sensitive in our impl, document it in DECISIONS.md and fix at the scorer level instead.)

Acceptance: in Mode A, the reference dancer's movements feel directionally aligned with the user (mirrored by default). Toggling off flips them back to "real" orientation. Skeleton overlay on REF stays glued to the dancer's joints when mirroring is toggled.

### Fix 3: AI-generated dance names via Gemini at ingest

User reports: current dance names are noisy. TikTok caption fields contain things like "original sound — username" or unrelated junk. These are useless as library titles.

**Fix in the worker ingest pipeline (`worker/ingest.py` or equivalent):**

Add a Gemini Flash call after audio + video are downloaded but before the dance row is finalized. Use this priority cascade to produce the display name:

1. **Try the TikTok caption first.** If the caption contains what looks like a song title pattern — e.g. `"<Artist> - <Song>"`, `"<Song> by <Artist>"`, or a recognizable title without "original sound" / "som original" / "nhạc nền" — use it as-is, cleaned up.

2. **Otherwise, send the audio to Gemini.** Use `gemini-2.5-flash` with thinking disabled. Send the first 15 seconds of `audio.wav` as input.
   Prompt:
   ```
   Listen to this audio clip from a TikTok dance video. If you recognize the song, respond with "<Artist> - <Song>". If you don't recognize it but can describe the genre/style in 2-4 words, respond with that (e.g. "Afrobeats groove", "K-pop chorus", "trap dance"). Respond ONLY with the name, no quotes, no explanation.
   ```
   Use the response as the display name.

3. **Fallback:** if Gemini call fails or returns garbage (empty, error, "I cannot..."), use `@<username>'s dance` as the display name.

Store the generated name in a NEW column `dances.display_name`. Do NOT overwrite the existing `title` column (preserves the raw TikTok caption for debugging). Frontend reads `display_name` if non-null, falls back to `title`.

**Schema migration (`supabase/migrations/0006_display_name.sql`):**

```sql
alter table dances add column if not exists display_name text;
```

**Reprocess implications:** after this fix lands, run `worker/reprocess_all.py` to populate `display_name` for the 8 existing dances. The reprocess script should detect the new column and call the naming function for any dance where `display_name IS NULL`.

Log every Gemini naming call to `worker/logs/vlm_calls.log` with token count.

Acceptance: after reprocess, all 8 dances in the library show clean names instead of "original sound" / "nhạc nền - douyin dance" / "som original". The `@hearts2miraaa` dance should show something like "Fetty Wap - Birthday Bounce" (already partially in caption — Gemini should clean it up).

### Fix 4: Restyle the Groov wordmark to feel energetic, not classy

User feedback: current Groov wordmark feels "too classy" — too restrained for a TikTok dance app aimed at teens. Needs to feel kinetic, weird, quirky, energetic.

**Fix in `components/Logo.tsx` (or wherever the wordmark lives — likely the home/library header):**

- Pick a more expressive web-safe display font. Recommended candidates (in order): **Bricolage Grotesque** (Google Fonts, modern weird-but-readable), **Space Grotesque** (techy, edgy), **Unbounded** (geometric and kinetic), or a free Pangram Sans variant. Avoid serif and avoid corporate sans-serifs like Inter / Helvetica.
- Apply visual treatment to make it feel alive:
  - Slight italic skew on the entire word (3-5 degrees)
  - The "V" at the end gets a custom letterform that kicks up — e.g. rotated 10° to the right, or replaced with an SVG glyph that has an exaggerated right leg
  - Optional: gradient fill in the existing hot-pink palette, going from the brand pink to a slightly lighter pink, top to bottom
- Keep the word "Groov" (no Y). The energy comes from typography, not renaming.
- Use the Direction 3 palette colors that are already defined in `lib/colors.ts` (or wherever).

Document the chosen font + treatment in `components/Logo.tsx` comments so future tweaks are easy.

Acceptance: opening the app library, the "Groov" wordmark visibly feels different — more kinetic, less restrained. Take a screenshot and compare before/after in the PR description.

### Fix 5: Library sort order — newest first, deterministic

User reports: library felt like it was sorting hearts2miraaa to the top because the user "used it most." Almost certainly NOT what's happening — there's no usage-based sort code unless explicitly built. More likely it's an accidental sort by `updated_at` (which gets bumped on every reprocess) or by some other field.

**Fix:**
- In the library query (likely `app/page.tsx` or `app/library/page.tsx`), explicitly sort by `created_at DESC` so newest dances appear first.
- Add an inline code comment explaining the sort choice so this isn't ambiguous later.
- Document in DECISIONS.md that library sort = `created_at DESC` (not usage-based). Usage-based sort is a future feature; we shouldn't ship a non-deterministic order.

Acceptance: dances appear in a consistent, predictable order across page loads. The most recently ingested dance appears first.

### Fix 6: Tap-to-preview on library cards

User feedback: library cards are static thumbnails. Adding a small preview-on-tap (YouTube-style) would help users decide which dance to try.

**Fix in the library card component:**

- Add a small play icon (▶) in the top-right corner of each thumbnail, ~24px, white on semi-transparent black circle background.
- On tap, the card plays the dance video muted, looping, for ~3 seconds. After 3 seconds, the preview stops and the thumbnail resumes.
- Tap the play icon again to stop the preview manually.
- Tap anywhere else on the card (outside the play icon) continues to behave as before — navigate into the dance.
- On hover (desktop) or long-press (mobile), the preview also starts. This is a nice-to-have, not required.

Don't autoplay on scroll — too aggressive, bad UX. User must explicitly tap the play icon.

Acceptance: tapping the play icon on a library card plays a 3-second muted preview of the dance video without navigating away from the library.

### Fix 7: Mode B test page UI audit

User reports: the Mode B test page UI is broken in undefined ways. Skeleton overlay sits too close to the controls. Some text/elements are missing or overlapping. (The user has screenshots but they didn't arrive in this round.)

**Fix:**

This is a UI audit, not a single-line patch. Open `app/dance/[danceId]/chunk/[chunkIndex]/test/page.tsx` and inspect it on a real mobile viewport (375px-414px wide). Specifically check:

1. **Skeleton overlay clipping:** the skeleton drawing canvas should be positioned so it never overlaps the bottom controls bar (50%/75%/100% buttons, skeleton toggle, back/test CTA). Add ~80px bottom padding to the camera+skeleton container if needed.
2. **Header text:** the "test · chunk 1/3" text should be visible, not cut off, and have adequate top margin below the iOS status bar / notch.
3. **Score display:** if a live score is rendered during Mode B (small number in a corner), make sure it doesn't sit underneath the user's pose or get clipped by safe-area insets.
4. **Bottom CTA visibility:** any "back" or post-test button must be tappable above the iOS home indicator (44px safe area at bottom).
5. **Consistency with Mode A:** the test page should structurally mirror the copy page layout (same header position, same control bar position, same panel sizing) so the user doesn't get disoriented moving between them.

Compare the test page side-by-side with the copy page during the audit. Document anything you change in the commit message.

Acceptance: the Mode B test page renders cleanly on a 390px-wide iPhone viewport with no overlapping elements, no cut-off text, no skeleton-on-controls collision.

## Order of implementation

Each fix gets its own commit. Do these in this order:

1. **Fix 1 (dead Mode B start button)** — critical, blocks the practice loop. `fix: mode B start button now triggers countdown and scoring`
2. **Fix 7 (Mode B UI audit)** — natural to do right after Fix 1 since you're already in that file. `fix: Mode B test page UI cleanup for mobile viewports`
3. **Fix 2 (mirror toggle)** — frontend only, low risk. `feat: mirror reference video horizontally with toggle, default ON`
4. **Fix 5 (library sort)** — one-line change. `fix: library sorts by created_at DESC for deterministic order`
5. **Fix 4 (wordmark restyle)** — frontend visual change. `feat: restyle Groov wordmark with kinetic typography`
6. **Fix 6 (preview-on-tap)** — frontend feature add. `feat: 3-second tap-to-preview on library cards`
7. **Fix 3 (AI dance names)** — biggest change, touches worker + schema + frontend. Two commits:
   - `feat: Gemini-based dance name generation in worker ingest pipeline`
   - `feat: frontend reads display_name with title fallback`

After Fix 3, run `worker/reprocess_all.py` to populate `display_name` for all 8 existing dances. Document the before/after names in the commit log.

## Acceptance test (run after all fixes ship)

1. Clear localStorage on test browser.
2. Open library — dances appear in `created_at DESC` order. ✓ Fix 5
3. The Groov wordmark in the header visually feels kinetic/energetic, not classy. ✓ Fix 4
4. Each library card has a play icon in the top-right corner. Tapping it shows a 3-second muted preview. ✓ Fix 6
5. Dance names are clean (e.g. "Fetty Wap - Birthday Bounce") not "original sound". ✓ Fix 3
6. Tap a dance → framing-check → pick-a-dancer (if 3+) → Mode A.
7. In Mode A, the REF dancer's movements feel directionally aligned with the user (mirrored by default). Toggle off → flips back. ✓ Fix 2
8. Tap "I got it · test" → land on Mode B test page.
9. Mode B page renders cleanly — no overlapping elements, no clipped text. ✓ Fix 7
10. Tap "start" on Mode B → 3-2-1-GO countdown → scoring begins. ✓ Fix 1
11. At end of chunk, a score appears.

## What NOT to change

- The three-layer lead detection (VLM + picker + heuristic) from last round — works correctly.
- The hands-free framing gate at `/onboarding/frame-check` — works correctly.
- The dual skeleton overlay logic — works correctly.
- The BoT-SORT tracker — untouched.
- The DTW scoring math layer — untouched.
- The pick-a-dancer screen layout — untouched (we just confirmed it works).

## Hard rules

1. One commit per fix as listed above (Fix 3 gets two commits).
2. `GEMINI_API_KEY` is already in env from last round. No new keys needed.
3. Run `worker/reprocess_all.py` after Fix 3 lands. Mandatory — otherwise old dances still show old names.
4. Apply migration 0006 in Supabase before reprocess (Claude Code: remind the user in the final summary that they need to do this manually before reprocessing).
5. Update RUNTIME_VERIFICATION.md with the new state after all seven fixes.

## Open issues being deferred to a later round (DO NOT IMPLEMENT)

These came up in user feedback but are bigger than this round. Do not touch them:
- "Chop the dance into coherent steps / show move-by-move learning" — this is the teaching loop / skill graph surfacing work. Deferred to next round.
- "Gemini takes screenshots during dancing to give feedback" — no. Pose detection + DTW already does this. Don't add a VLM here.
- "Have Gemini break moves into singles and combos" — this is teaching-loop work, deferred.

Document these in DEFERRED.md if it doesn't exist yet.

Begin.