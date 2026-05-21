# spec.md — Round 4: Real multi-person tracking + start-screen + TikTok-style duet

## Read before starting

Read RUNTIME_VERIFICATION.md, DECISIONS.md, and OVERNIGHT_SUMMARY.md to understand current state. Round 3 shipped a centroid tracker + 3-2-1 countdown + side-by-side duet. Real-world testing on phone revealed they don't work well enough. This round is targeted fixes, not a rewrite.

## What's actually wrong (verified by user testing)

### Problem 1: Multi-person tracker is still fragmenting dancers

Round 3 increased the centroid tracker's active window to 2.5s and added a post-merge pass. It helped (down from 5+ dancers to 2-4) but it's still fundamentally the wrong algorithm. When two dancers overlap, swap positions, or one briefly crosses in front of the other, the centroid tracker can't tell them apart. It still assigns the same person to multiple IDs.

**Centroid tracking only uses position. To do this right, the tracker needs APPEARANCE EMBEDDINGS — a learned visual fingerprint of each person.**

### Problem 2: No start screen / countdown is automatic, not user-initiated

User opens Mode A and the video starts playing immediately. There's no "press start when you're ready" moment. Same with Mode B — it just starts scoring. The 3-2-1 countdown that shipped in Round 3 exists between modes but not at the START of the practice session. User wants a "press start" button + countdown overlay that triggers BEFORE Mode A begins, and again before Mode B begins.

### Problem 3: Duet layout doesn't match TikTok Duet visually

Round 3 shipped side-by-side. The math is right but the videos are too narrow because they're forced into the leftover vertical space below a header. Real TikTok Duet has black bars top/bottom and the two videos fill the entire horizontal width edge-to-edge, preserving 9:16 aspect ratio per side. The videos look SMALL right now compared to a real TikTok Duet.

### Problem 4: Framing check onboarding isn't triggering / user doesn't know they're badly framed

User tested while lying in bed with terrible framing (face close to camera, no full body visible). Pose detection on bad framing produces garbage skeletons. The framing-check onboarding exists at `/onboarding/frame-check` but doesn't appear to trigger on first practice, AND there's no mid-session warning when the user's framing drops below quality threshold.

## Fixes — do in this exact order

### Fix 1: Replace centroid tracker with BoT-SORT

This is the architectural fix. Don't try to make the centroid tracker work — it can't. Replace it with BoT-SORT via the Ultralytics library.

**Implementation in `worker/pose.py`:**

1. Add `ultralytics` and `lap` to `worker/requirements.txt`. Pin versions: `ultralytics>=8.3.0` and `lap>=0.4.0`.

2. Use Ultralytics YOLOv8-pose with `tracker="botsort.yaml"` for the person detection + tracking pipeline.

3. The new flow:
   - Load YOLO11n-pose or YOLO11s-pose model (download on first use, cache in worker/models/)
   - For each frame, call `model.track(frame, persist=True, tracker="botsort.yaml")`
   - The result includes track IDs that persist across frames AND across brief occlusions
   - Each track has a stable ID for the duration the person is in the video
   - The pose keypoints are still 17 landmarks (COCO format, compatible with existing scorer)

4. For each unique track ID across the whole video:
   - Compute lead_score (same formula as before: centrality + size + forwardness + persistence)
   - Use this to auto-select the best dancer
   - Compute `requires_dancer_pick = (gap_between_top_two < 0.15)`

5. Store all tracks in the pose JSON (one track per unique ID), exactly like before. The schema doesn't change — only the algorithm producing the tracks changes.

6. The post-processing merge pass from Round 3 should be REMOVED. BoT-SORT handles re-identification natively; the merge pass was a band-aid that's no longer needed.

**Verify on a 2-person TikTok:** the BoT-SORT pipeline should produce exactly 2 tracks for a 2-person video, even if the dancers cross paths or briefly occlude each other.

**Acceptance test:** Run on the existing `@hearts2miraaa` 2-dancer video. The pick-a-dancer screen should show exactly 2 thumbnails, not 3-4.

### Fix 2: Add "press start" + countdown overlay BEFORE Mode A

The video should NOT start playing on page load. Instead:

1. When the user lands on `/dance/[id]/chunk/[i]/copy` (Mode A) or `/test` (Mode B), the video is paused at frame 0 and audio is muted/paused.

2. Render an overlay on top of the duet layout that says:
   - Big text: "section 1 of 3" (or whatever chunk)
   - Sub text: "watch first, then copy" (Mode A) or "ready to dance?" (Mode B)
   - Big primary CTA button: "start" in hot pink
   - Tapping "start" begins the 3-2-1 countdown

3. The 3-2-1 countdown (already exists in `lib/audio/tick.ts` from Round 3) plays. At "GO" the overlay dismisses and the video/audio starts simultaneously.

4. The countdown CANNOT be skipped. Always plays.

5. If the user pauses mid-chunk (e.g. taps back arrow), returning to the chunk should re-show the start overlay — not auto-resume.

**Applies to Mode A AND Mode B.** Both need start screens. The countdown exists; just gate it behind a tap rather than auto-running.

### Fix 3: Fix the duet layout to mimic TikTok Duet

Reference visual: TikTok's official Duet feature. Black bars top and bottom (or filled with score UI), two videos side-by-side filling the entire horizontal width edge-to-edge, each preserving 9:16 aspect ratio.

**Implementation in `app/dance/[danceId]/chunk/[chunkIndex]/copy/page.tsx` (and the test page):**

1. Layout structure:
```
+------------------------+
|  status bar / header   |  <-- compact, ~50px
+------------------------+
|                        |
|                        |
|   [REF]   |   [YOU]    |  <-- edge-to-edge horizontal, each side is exactly half the screen width
|           |            |  <-- preserves 9:16 aspect ratio (so height = (screenWidth / 2) * (16/9))
|                        |
|                        |
+------------------------+
|  controls + CTA        |  <-- bottom controls, ~120px
+------------------------+
```

2. Each side of the duet is `width: 50vw` and `aspect-ratio: 9/16`. The two videos sit flush against each other in the middle of the screen with black bars (or controls/UI) filling the top and bottom.

3. Critical: the videos are NOT stretched or cropped. They preserve aspect ratio. If the source video has a different aspect ratio (some TikToks are 16:9 or square), `object-fit: contain` with black letterbox.

4. The "REF" label and "YOU" label are small chips in the top-left corner of each side.

5. The skeleton toggle, speed toggle (50/75/100%), "back to lesson", and "I got it · test" button all sit in the bottom 120px area.

6. On phones smaller than 400px wide, the duet should still be side-by-side. Don't fall back to stacked.

### Fix 4: Mandatory framing check on first practice + mid-session quality warning

**Onboarding gate:**

1. The first time a user taps "start" on any Mode A or Mode B (across all dances), check localStorage for `framing_calibrated: true`.

2. If NOT calibrated, redirect to `/onboarding/frame-check` BEFORE starting the chunk. After they complete (or skip) onboarding, return to the chunk they were trying to start.

3. The onboarding screen should be friendly but firm:
   - Title: "let's get you framed"
   - Subtitle: "find a spot where your whole body fits — back up if you need to"
   - Live camera feed with a translucent silhouette overlay showing ideal framing (head near top, full body, feet near bottom)
   - When user's pose lands inside the silhouette for 2 consecutive seconds, silhouette turns hot pink (Direction 3 accent) and "got it" button appears
   - Small "skip" link bottom-left (don't fully block — let users override)

**Mid-session warning:**

1. In Mode B (the scored test), if pose confidence drops below 0.5 for >1.5s, show a floating toast in the bottom-left: "step back so we can see all of you"

2. Toast auto-dismisses when confidence recovers above 0.7.

3. Toast does NOT block scoring — it informs the user, doesn't punish them.

## What NOT to change

1. Do NOT change the math layer (DTW, joint angles, scoring, similarity). Tested and correct.
2. Do NOT change the home/library screen — it's fine.
3. Do NOT change the Direction 3 palette — locked.
4. Do NOT add face ID / biometric body type / re-identification by face. Privacy nightmare.
5. Do NOT change the "submit a tiktok" flow — it works.

## After fixes — re-process the existing dances

The new tracker will produce different (better) pose tracks for the existing 8 dances. Re-process them via the worker pipeline so the database has the BoT-SORT output, not the centroid tracker output.

Run a script `worker/reprocess_all.py` that:
1. Iterates over all `status='ready'` dances in Supabase
2. Re-runs the pose extraction pipeline on each (using the cached mp4 from the `videos` bucket if available, or re-downloading from TikTok URL if not)
3. Updates the dance record with the new pose data
4. Logs success/failure

If reprocessing a dance fails (mp4 expired, etc.), mark it as `status='failed'` and continue.

## Hard rules

1. BoT-SORT integration must work end-to-end before moving to Fix 2.
2. Fix 2 (start screens) must work before Fix 3 (duet layout).
3. Commit each fix as a separate commit.
4. The acceptance test for Fix 1 (the @hearts2miraaa video produces exactly 2 dancer tracks) is mandatory. If it doesn't work, document in BLOCKERS.md and stop — don't ship a broken multi-person tracker.
5. Don't add new external dependencies beyond ultralytics + lap.
6. The ultralytics install may take 10-20 minutes due to PyTorch download. That's fine. Update the SETUP_TODO.md to note this.

## Success criteria

User opens the app on phone Safari, taps a 2-person dance from the library:
1. "Pick a dancer" screen shows exactly 2 thumbnails (BoT-SORT working)
2. After picking, lands on the dance overview
3. Taps Section 1
4. Sees a "start" overlay with the chunk title and a big hot-pink "start" button
5. Taps start → 3-2-1 countdown plays with audible ticks → video starts at GO
6. The duet layout looks like TikTok Duet — edge-to-edge horizontal, both videos visible at proper size, NOT shrunk into the bottom half of the screen
7. User taps "I got it · test"
8. Another start overlay with 3-2-1 countdown before scoring begins
9. If framing was bad, a toast appears mid-attempt warning to step back

Begin.