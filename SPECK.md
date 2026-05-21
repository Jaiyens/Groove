## Goal

Real-world testing on phone revealed that everything except the home screen is broken or wrong. This prompt fixes the critical functional issues, redesigns Mode A around the actual TikTok video (not a generated skeleton video), applies the Direction 3 visual palette, and ships the multi-person + tracking work.

Read RUNTIME_VERIFICATION.md, DECISIONS.md, and OVERNIGHT_SUMMARY.md before starting.

## What's broken right now (verified by user testing on phone)

1. **Mode A shows a janky stick figure instead of the actual TikTok video.** Charli (the dancer) is invisible. This is unusable — you can't learn from a floating skeleton on a black background.
2. **Camera doesn't initialize** in Mode A — PIP says "no camera."
3. **No audio** in Mode A.
4. **The PIP layout doesn't feel like a TikTok Duet.** Floating tiny window in a corner is wrong. Duet is split-screen.
5. **Back navigation doesn't work** across most screens.
6. **Dance titles are showing the TikTok caption text** (e.g., "dc @calvitjr @Sara Biv") instead of a clean title.
7. **Most UI elements aren't actually functional** — buttons that look tappable don't do anything.
8. **Direction 3 palette never got applied** — the app is currently warm coral / cream (Direction 1).
9. **Multi-person dancing isn't supported** — when a TikTok has multiple dancers, the worker silently picks the wrong one.
10. **Pose tracking on the user's camera is unreliable** — doesn't stick to limbs, gets stuck when user leaves frame.

## Fixes (do in order)

### Phase 1: Critical functional fixes (must work before anything else)

#### Fix 1.1: Redesign Mode A to use the actual TikTok video

This is the biggest change. Mode A previously played a worker-generated "skeleton-only video" — that approach is being abandoned because it looks like a glitchy stick figure and you cannot learn from it.

The new Mode A:

- **Top half of the screen:** the original TikTok video plays full-bleed vertical. Looping the current chunk. Speed control still works (50/75/100%). Audio plays from this video.
- **Bottom half of the screen:** the user's front-facing camera, mirrored. Same vertical aspect ratio. This is TikTok Duet style.
- **No "no camera" empty state** — if camera permission is denied, show a clear request banner with a button to grant permission. If denied permanently, show instructions to enable it in Settings.
- **Skeleton overlay toggle:** small button in the corner of the reference video that says "show skeleton." When OFF (default), the user sees Charli's actual body. When ON, the pose landmarks render as white lines OVER the video.

To make this work, the worker needs to ALSO upload the original mp4 (not just the skeleton mp4). Add a `video_url` column to the `dances` table for the actual video (separate from `skeleton_video_url`).

Migration:
```sql
alter table dances add column if not exists video_url text;
```

Update the worker to upload the original mp4 to a `videos` storage bucket (create it if it doesn't exist) and populate `video_url`.

The skeleton_video_url remains useful as an OVERLAY only, but for now you can also just compute the skeleton client-side from the pose JSON. Either approach is fine — pick whichever ships faster.

#### Fix 1.2: Fix camera initialization

The Mode A screen says "no camera." Diagnose by reading the existing Mode A component code. Likely causes:
- `getUserMedia` isn't being called
- Permission state isn't being checked
- The HTTPS requirement isn't met on local network — `192.168.4.38:3000` is HTTP, which blocks camera on most browsers
- The video element isn't getting the stream attached

**The HTTPS issue is the most likely culprit.** Modern browsers block camera access on HTTP origins except for localhost. Solutions:
- Use `next dev --experimental-https` to enable HTTPS on the dev server
- Or set up `mkcert` for a local CA and serve over HTTPS that way
- Document this in DECISIONS.md so the user knows

#### Fix 1.3: Fix audio

The Mode A screen has no sound. Diagnose:
- Is the audio element actually being created?
- Is the `audio_url` from the dance record being passed?
- Is the user gesture requirement being met? (Browsers require a user click before audio can play — autoplay is blocked)
- Is the audio element muted by default?

Likely fix: audio needs to start on the same user tap that starts the chunk playback. Don't autoplay on screen mount.

Actually with Mode A now showing the real video, the audio comes from the video itself. So this might solve itself when Fix 1.1 lands. Verify.

#### Fix 1.4: Fix back navigation

Every screen that has a back arrow needs to actually go back. Right now they don't. Add Next.js router.back() to every back button. Use the `useRouter` hook from `next/navigation`. Test every screen.

If there's no in-app back arrow, add one to the top-left of every non-home screen. Library is the home — every other screen has a back arrow.

#### Fix 1.5: Fix the dance title metadata

Dances are showing titles like "dc @calvitjr @Sara Biv" which is just the TikTok caption. This is wrong.

Update the worker to:
- Extract the song title and artist from the TikTok metadata (yt-dlp returns this in the `title`, `track`, `artist` fields from the audio metadata)
- Compose a clean title: prefer `track` if available, fall back to first ~30 chars of the description with hashtags stripped
- Use the TikTok creator handle as the subtitle

Example: instead of "dc @calvitjr @Sara Biv" → "Back Again" with subtitle "@charlidamelio"

For existing dances in the DB, write a one-time migration to clean up their titles:
```sql
-- Or do this via a Python script that re-fetches metadata
```

#### Fix 1.6: Make every UI element functional or remove it

Audit every visible button, tab, and interactive element. For each one:
- If it has a real action: wire it up.
- If it doesn't yet have a real action: replace with "coming soon" state OR remove it from the UI.

No more buttons that look tappable but do nothing. That breaks user trust faster than anything.

Specifically check:
- Bottom nav (Library / Progress / Profile)
- The "submit a tiktok" floating button
- Lock icons on locked chunks
- Speed toggle buttons
- "I got it · test" button
- The audio control icon top-right
- The home button top-left

### Phase 2: Apply Direction 3 palette

The current UI uses Direction 1 (warm coral on cream). The user wants Direction 3 (off-white with electric hot pink accents).

Locked palette:
```css
--bg:               #F8F8F6;  /* off-white background */
--surface:          #FFFFFF;  /* cards, modals */
--text-primary:     #0A0A0A;  /* near-black */
--text-secondary:   #6B6B6B;  /* muted gray */
--text-tertiary:    #A8A8A6;  /* light gray */
--border:           #E5E5E1;  /* warm light gray */
--accent:           #FF3E7F;  /* hot pink — used sparingly */
--accent-hover:     #D1305F;  /* hot pink hover */
--success:          #00C26B;  /* electric green for high scores */
--warning:          #FFB800;  /* signal amber for mid scores */
--danger:           #FF3E3E;  /* alert red for low scores */
--cta-primary:      #0A0A0A;  /* black CTA with white text */
```

**Rules for hot pink usage** (restraint is the point):
- Score number on results screen (the big celebration moment)
- The "submit a tiktok" floating button
- The streak flame icon
- Active state on the bottom nav (the currently-selected tab)
- Top score in the per-skill breakdown (the highest one)

Everywhere else: black-on-off-white. White cards on the off-white background. Borders are subtle.

Typography:
- Font family: Inter throughout (already loaded via Next.js fonts or add via @next/font/google)
- Weights: 400 regular, 500 medium. No 600/700.
- Lowercase by default for headings ("groove" not "Groove", "library" not "Library")
- Numbers should use `font-variant-numeric: tabular-nums` for tabular alignment in scores

Wordmark: "groove" lowercase, weight 500, slight negative letter-spacing (-0.02em). NOT a serif font (the previous "Groove" in Georgia serif is being replaced).

Update every component file to use the new CSS variables. Search for hardcoded `#FAF6F0`, `#E27A56`, `#1A1410`, etc. and replace.

### Phase 3: Multi-person dance support

When a submitted TikTok has multiple dancers, currently the worker picks one arbitrarily.

Update `worker/pose.py` to:

1. **Detect all people in every frame** using MediaPipe Pose Landmarker with `num_poses=5` (or switch to YOLOv8-pose if MediaPipe limits to 1).
2. **Track each detected person across frames** using a simple centroid tracker:
   - Match new detections to existing IDs by minimum distance between root joints
   - If a person isn't seen for >0.5s, drop the ID
   - New person = new ID
3. **Compute a lead_score per person across the whole video:**
   - centrality: avg distance from frame center (closer = higher)
   - size: avg bounding box area (bigger = higher)
   - forwardness: avg feet y-position (closer to bottom = more downstage)
   - persistence: fraction of frames detected (higher = lead)
   - `lead_score = 0.3*centrality + 0.3*size + 0.2*forwardness + 0.2*persistence`
4. **Pick the top-scoring person as auto-selected.**
5. **Store ALL persons' pose tracks** in the pose JSON, not just the chosen one.
6. **Compute confidence:** if (top score - second score) < 0.15, set `requires_dancer_pick = true`.
7. **Save a thumbnail of each detected person** for the "pick a dancer" UI.

Schema additions:
```sql
alter table dances add column if not exists dancer_count int default 1;
alter table dances add column if not exists auto_selected_person_id text;
alter table dances add column if not exists person_thumbnails jsonb;
alter table dances add column if not exists requires_dancer_pick boolean default false;
```

Frontend: when `requires_dancer_pick = true`, route the user to a new screen `/dance/[id]/pick-dancer` that shows the person thumbnails and lets them tap one. The choice updates `auto_selected_person_id`. Then they proceed.

If `requires_dancer_pick = false`, skip that screen.

Add a small "change dancer" link in the top-right of the dance overview so users can re-pick later.

### Phase 4: Pose tracking reliability (user's camera in Mode B)

The user reported that the pose model in Mode B doesn't stick to limbs and gets stuck when they leave frame.

Update `lib/pose/poseExtractor.ts`:

1. Switch from MediaPipe Pose Landmarker `Lite` to `Full` model. Change the model file URL: `pose_landmarker_lite.task` → `pose_landmarker_full.task`.
2. Fix the "stuck skeleton" bug: detector must run every animation frame. If detection returns no pose, hide the skeleton (don't freeze the last result). When detection returns a pose again, the skeleton re-appears.
3. Expose a confidence score per frame.
4. If confidence drops below 0.5 for >1.5s, show a floating toast: "adjust your framing." Tapping it overlays a silhouette guide for 2s. If confidence recovers above 0.7, dismiss the toast.

Onboarding calibration (one-time):

Route: `/onboarding/frame-check`. Show:
- Camera view full-screen
- Translucent silhouette overlay showing ideal body framing
- When user's pose is detected AND all 17 joints are inside the silhouette for 2 consecutive seconds → silhouette turns green → "Got it" button appears
- Small text: "Stand back so your whole body fits. Use a plain wall behind you. Find good light."
- Skip button (small, bottom-left)

After completion, save `framing_calibrated: true` to localStorage. Don't show again unless user clicks "re-calibrate" from settings.

### Phase 5: Re-test and write status report

After all phases ship:
1. Run the pipeline on a 1-person Charli TikTok (already in library) → verify Mode A works (Charli visible, audio playing, camera shows, score updates in Mode B).
2. Run the pipeline on a 2-person TikTok (find one — e.g. a Charli duet) → verify the dancer-pick flow triggers if confidence is low.
3. Update RUNTIME_VERIFICATION.md with the new state.
4. Tell the user the dev URL again and what to test.

## Hard rules

1. Phase 1 must ship before Phase 2 starts. Function before form.
2. Do NOT change the math layer (DTW, joint angles, scoring). Tested and correct.
3. Do NOT keep the skeleton-only video as Mode A's reference. The real TikTok is the reference. The skeleton is an OVERLAY toggle, opt-in.
4. Commit each fix as a separate commit.
5. If you hit a blocker that requires user action (e.g. HTTPS setup, env var), write it to BLOCKERS.md clearly and continue with what you can.
6. The user's previous DECISIONS.md established that the math layer is portable to Swift. Keep new code in the same shape.

## What success looks like

User opens dev URL on phone:
1. Library shows 3 Charli dances with clean titles, hot pink "submit a tiktok" button, off-white palette
2. Taps a dance → chunk overview loads with proper title
3. Taps section 1 → Mode A loads. Charli's actual video plays top half. User's camera works in bottom half. Audio plays. Skeleton toggle hidden by default.
4. Watches and copies → taps "I got it · test" → Mode B starts. Audio continues. Camera goes fullscreen with skeleton overlay tracking user's body reliably.
5. Score appears at end of chunk. If above 70, chunk 2 unlocks.
6. Submits a 2-person TikTok → if confidence is low, "pick a dancer" screen appears with thumbnails. Pick one. Continue.

Begin.