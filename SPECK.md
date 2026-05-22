# Spec: Preview audio, kill framing screen, dance-page UI cleanup

Four fixes. Do them in the order listed. After each one, run the app locally and verify the acceptance criteria before moving to the next. Ask me a clarifying question if anything is ambiguous — don't guess.

---

## Fix 1: Preview video must auto-play with sound on tap

### Problem
On the library screen, when I tap a dance card to preview it:
- The video doesn't load / plays for ~2 seconds and dies
- There is no audio at all

This is the most important fix in the entire spec. **People recognize TikTok dances by the song, not by the title.** A silent broken preview makes the library unusable.

### Required behavior
1. When the user taps a dance card to open the preview, the reference video **starts playing immediately with sound on**.
2. Video must play all the way through (the full chunk duration), not cut out at 2 seconds.
3. Audio comes from the reference video's own audio track. Do not mute, do not lower volume, do not use a separate audio file.
4. The user can pause and replay it. A simple play/pause toggle on tap is fine.
5. If the user opens a different dance card, the previous video stops cleanly (no audio bleed).

### Implementation notes
- Browser autoplay-with-sound is allowed *because the autoplay is triggered by a user tap gesture*. Do **not** try to autoplay on initial page load or on hover — that will be blocked by Safari. The play call must fire inside the click/tap event handler.
- Use the HTML5 `<video>` element with `playsInline` (required for iOS Safari to not go full-screen), `controls` (so the user can scrub), and **do NOT set `muted`**.
- The `<video>` element must have a valid `src` (or a `<source>` child) pointing to the reference video file. The 2-second cutoff suggests either a broken src, a CORS issue on the video host, or a state bug that's unmounting the video element. Diagnose which one. Fix the root cause; do not paper over it with a retry loop.
- If the video file is hosted somewhere with bad CORS or short-expiry signed URLs, fix the hosting / refresh-URL logic. Tell me what you found.

### Acceptance criteria
- Tap any dance card. Within 500ms, video starts playing **with audible sound**.
- Video plays continuously from start to end of chunk without cutting out.
- Tapping pause stops it. Tapping play resumes it.
- Opening a second dance card stops the first one's audio.
- Works on iPhone Safari (the actual demo target).

---

## Fix 2: Remove the framing screen entirely

### Problem
The "put your whole body in frame" screen is broken — detection doesn't reliably fire — and conceptually wrong for this app. Most TikTok dances only need upper body + knees, not full body. We were over-engineering this.

### Required behavior
1. **Delete the framing screen entirely.** No body-detection gate, no countdown driven by detection, no "I'm in frame" button.
2. The user goes directly from the dance card / setup screen into the dance, with whatever existing start trigger we already have (tap "start" or similar — keep the current trigger if there is one, otherwise add a simple "start" button).
3. On the dance card / setup screen (the screen BEFORE the user enters the chunk), add a clear, visible instructional note:

   > **Stand back so your arms, legs, and knees are visible in the camera.**

   Style this prominently — not a tiny grey caption. Think: a small card or callout with an icon, sitting above the "start" button. The user must see it before tapping start.
4. The camera feed should still preview during the dance (so the user sees themselves) — we're only removing the *gate*, not the camera.

### Implementation notes
- Remove any framing-related state, components, detection callbacks, and countdown logic from the chunk-entry flow. Clean it out — don't leave dead code paths.
- Keep the framing detection *code* in the repo if it's reusable, but it should not be wired into the user flow.
- The setup screen note should be styled consistently with the rest of the UI (see Fix 3).

### Acceptance criteria
- Tap a dance card → see the preview (Fix 1) and a visible "stand back so your arms, legs, and knees are visible" note on the setup screen.
- Tap "start" → goes directly into the dance. No framing check, no countdown that waits for detection.
- No "put your whole body in frame" screen exists anywhere in the flow.
- Camera preview still works during the dance.

---

## Fix 3: Dancing page UI cleanup

### Problem
The actual dance page (where the reference video plays and the user dances along) has:
- Buttons too close together — accidental taps are easy
- UI shifts around / feels jittery
- Overall layout feels cramped and unprofessional

### Required behavior
1. **Spacing.** Every tappable element gets a minimum 12pt margin from any other tappable element. Minimum tap target size of 44x44pt (Apple HIG standard) for every button.
2. **Static layout.** The page must not shift elements around mid-dance. Lay out the page once on entry and keep the structure fixed. If a button changes (e.g. play → pause), it changes in place — same position, same size, only the icon/label changes.
3. **Hierarchy.** Clear visual hierarchy:
   - Reference video: largest element, top of screen.
   - User camera preview: secondary, smaller, positioned consistently (suggest: lower-left or picture-in-picture style).
   - Controls (pause, restart, exit): grouped together at the bottom in a single row, evenly spaced, NOT scattered.
4. **No overlapping elements** unless they're intentionally stacked (camera-on-video PiP is fine; floating control over text is not).
5. **Visual polish.** Consistent border radius, consistent button styles, consistent typography. Pick one button style and use it everywhere on this page.

### Implementation notes
- Before changing anything, take a screenshot of the current dance page and put it in `/screenshots/before-dance-page.png` for reference.
- After the fix, take another screenshot at `/screenshots/after-dance-page.png`.
- Do NOT introduce new dependencies (no new UI libraries). Use what's already in the project.
- Test on a 390px-wide viewport (iPhone 14/15 width) — that's the demo target.

### Acceptance criteria
- All buttons are at least 12pt apart and at least 44x44pt.
- Page layout doesn't shift after initial render (no CLS-style jumps).
- All controls (pause, restart, exit, anything else) are in a single grouped row at the bottom.
- The page looks clean and intentional, not cramped.
- Works at 390px width without horizontal scroll.

---

## Fix 4: Name change — "Groove" replacement

I want to replace the app name "Groove." It's too generic. Brainstorming options below — I'll pick one and tell you. **Do not change the name anywhere in the codebase yet.** This is a parallel branding exercise; the rename happens in a separate prompt once I decide.

(See name brainstorm in my chat reply — not part of this spec file.)

---

## Workflow

1. Start with **Fix 1** (preview audio). This is highest priority.
2. After Fix 1, ask me to test it on my phone before moving on.
3. Then **Fix 2** (kill framing). Quick fix — mostly deletion.
4. Then **Fix 3** (dance page UI). Take the before/after screenshots.
5. **Skip Fix 4** until I send a separate naming prompt.

If you hit a fork in the road on any of these — especially if the video issue turns out to be a hosting/CORS problem and not a code problem — stop and ask me. Don't guess.