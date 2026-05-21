## Goal

Fix three real issues found in real-world phone testing, then seed the library with 5 user-provided TikTok URLs.

Read RUNTIME_VERIFICATION.md, DECISIONS.md, OVERNIGHT_SUMMARY.md, and any other recent docs before starting. The user has already verified the core loop renders correctly on phone (real video plays in Mode A, camera works, palette is Direction 3). These are targeted fixes, not a rewrite.

## Issues found during phone testing

### Issue 1: Multi-person tracker over-fragments the same dancer

A 2-person Charli D'Amelio video produced 5+ "dancer" thumbnails in the picker UI. The same dancer is being assigned multiple person IDs because the centroid tracker drops the ID when the dancer is briefly occluded by another dancer or temporarily leaves frame. When she reappears, the tracker treats her as a new person.

Visible symptom: the "Pick a dancer" screen shows P0, P1, P2, P3, and partial P4 for what should be 2 distinct people. When the user selects P2 (currently selected), they only get the second half of Charli's appearance in the video.

**Fix in `worker/pose.py` (or the tracker file):**

1. Increase the "missing person" timeout from 0.5s to 2.5s. Briefly losing detection due to occlusion or partial frame exit should NOT terminate an ID.

2. When a new detection appears, do not just match by closest current centroid. Also compare against RECENTLY EXPIRED tracks (last 2.5s). If the new detection's centroid is within 0.25 of frame width from an expired track's last known position AND the bounding box size is within 30% of the expired track's avg size, re-attach to that ID instead of creating a new one.

3. After all tracking is done, do a post-processing merge pass: any two tracks where (a) one ends before the other starts, (b) the centroid positions are close, and (c) the body sizes are similar — merge them into one track.

4. Drop any final track that has < 25% temporal coverage of the video (transient detections, partial-frame artifacts).

5. Cap final detected persons at 4. If more than 4 tracks survive, keep the 4 with highest persistence scores.

### Issue 2: No 3-2-1 countdown between Mode A (copy-along) and Mode B (scored test)

User taps "I got it · test" in Mode A and immediately gets dropped into a scored attempt. This is jarring and unfair — they need a beat to physically prepare to dance, and a sync moment so their movement aligns with the audio start.

**Fix:**

1. After user taps "I got it · test" in Mode A, route to a `/dance/[id]/chunk/[i]/get-ready` intermediate screen (or render it inline as a state of the test page).

2. The get-ready screen shows:
   - A still frame of the user's camera with skeleton overlay (so they can confirm they're in frame)
   - Large countdown numbers: 3 → 2 → 1 → GO
   - Each number visible for ~1 second (3 sec total)
   - Number changes are accompanied by a brief audible tick / beat sound (use Web Audio API to generate a short 880Hz tone — no external file needed)
   - "GO" is in hot pink (the accent color)
   - At the same moment "GO" appears, the dance audio starts and Mode B pose scoring begins

3. The countdown CANNOT be skipped. It always runs.

4. After Mode B finishes (chunk done), the next attempt also gets the 3-2-1 countdown.

### Issue 3: Duet layout is stacked vertically, should be side-by-side

Currently Mode A shows the reference TikTok video on top and the user's camera on bottom (vertical stack). User wants side-by-side: reference on left, camera on right. This matches the visual model of TikTok Duet (which is the mental model every user already has).

**Fix:**

1. Change Mode A layout in `app/dance/[danceId]/chunk/[chunkIndex]/copy/page.tsx`:
   - Two equal columns: reference video on LEFT, user camera on RIGHT
   - Both columns are vertical aspect ratio (9:16-ish) to match TikTok video format
   - On mobile portrait, each takes 50% width
   - The two videos are exactly the same height
   - "YOU" label in the top-left of the user camera, "REFERENCE" or no label on the left
   - The skeleton toggle, speed toggle, "I got it · test" button, and back arrow all stay in their current vertical positions but rendered BELOW or ABOVE the duet area

2. If side-by-side makes the videos too small to be useful, fall back to stacked. But TRY side-by-side first and only fall back if videos are < 200px wide on a standard phone (390px viewport).

3. Mode B (scored test) does NOT need a duet — that one stays full-screen camera with skeleton overlay (this is already correct, do not change).

### Issue 4: Thumbnail diversity

All 3 existing Charli dances in the library have nearly identical thumbnails because the worker uses frame 0 (the first frame) of each video. Charli starts in the same position in all her videos so they look identical.

**Fix in `worker/thumbnail.py`:**

1. Instead of frame 0, pick the frame at 30% through the video. Most TikToks are warming up at frame 0; 30% in, the dancer is mid-movement and the pose is distinctive.

2. Additionally, if the chosen frame has a low pose confidence (dancer is partially out of frame or blurred), fall back to the frame at 50% or 70%. Pick whichever has the highest pose confidence among the candidates.

## After fixes are deployed

### Seed the library with 5 user-provided dances

The user provided these 5 TikTok URLs. Strip any `?q=` query parameters before submitting (so we don't store duplicate URLs with tracking params). Submit each via the worker pipeline:

```
https://www.tiktok.com/@.eslis/video/7615100643732229406
https://www.tiktok.com/@akeesavv/video/7627655253525155102
https://www.tiktok.com/@user4468273678/video/7621787722419539214
https://www.tiktok.com/@hearts2miraaa/video/7496177072180759854
https://www.tiktok.com/@ab3l.t/video/7612422950465064206
```

For each URL:
1. Strip query strings
2. Submit via `python main.py --once <url>` to trigger the full new pipeline (with the fixed multi-person tracker and the new thumbnail logic)
3. Wait for completion before moving to the next
4. Log success or failure for each

If any fail (TikTok blocked, region locked, etc.), document in BLOCKERS.md and continue with the rest.

### Verify the success path on each

After seeding, query the database to confirm each dance has:
- `status = 'ready'`
- `video_url` populated
- `pose_data_url` populated
- `audio_url` populated
- `thumbnail_url` populated
- `dancer_count >= 1`
- A non-empty `title` that doesn't look like a TikTok caption (e.g. no "dc @username" or "#hashtag" structure)

Print a summary table.

### Then update RUNTIME_VERIFICATION.md

With the final state: 5 new dances seeded, 3 fixes shipped, link to the Vercel URL the user should test on.

## Hard rules

1. Do NOT change the math layer (DTW, joint angles, scoring). Tested and correct.
2. Do NOT change anything about the home/library, palette, or pick-a-dancer UI that's already working — only the parts called out above.
3. Do NOT introduce new external dependencies.
4. Commit each fix as a separate commit so the work is reviewable.
5. Run the full pipeline locally with the worker running to verify each seed URL works end-to-end.

## What success looks like

1. User submits a 2-person TikTok → "Pick a dancer" screen shows exactly 2 thumbnails (not 5+)
2. User selects one → that dancer's full pose track is used (not just half)
3. User taps "I got it · test" → 3-2-1 countdown plays with audible ticks → Mode B starts
4. Mode A shows reference video LEFT, user camera RIGHT, side-by-side
5. Library shows 5 new dances with diverse, distinct thumbnails (not the same frame-0 face)

Begin.