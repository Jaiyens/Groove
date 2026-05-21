# spec.md — Fix the framing-check flow

## What's broken (from real phone testing)

User tapped @hearts2miraaa from the library. No pick-a-dancer screen appeared — correct behavior, the worker only detected one lead dancer. So the user went straight from library tap → framing-check screen.

Two problems with the framing-check screen as it stands:

### Problem 1: It demands full body, but most TikTok dances only need upper body

The current `/onboarding/frame-check` requires all 17 pose joints (including ankles + feet) inside the silhouette before the "got it" button appears. That's wrong for our use case. The vast majority of TikTok dances we're targeting — Charli moves, hand-heavy choreo, hearts2miraaa, etc. — are upper-body dances. The user only needs to be visible from roughly the knees up. Requiring feet-in-frame forces users to stand way back, which makes the dance feel weird on a phone screen and breaks the experience in small rooms.

### Problem 2: The "got it" button is unreachable when the user is in dance position

The "got it" CTA sits at the bottom of the framing screen and requires a tap. But if the user has already stepped back far enough to fit in frame, they're nowhere near the phone. They'd have to walk back to the phone, tap the button, then re-position. That breaks the flow every single time.

## The fix — unified hands-free framing gate

Replace the current framing-check behavior with this:

### 1. Lower the framing requirement to upper-body-only

The "framed correctly" condition becomes: **all joints from the knees up are detected with confidence > 0.5 and inside the silhouette area**.

Specifically, the required COCO joints are:
- nose (0)
- left/right eye (1, 2)
- left/right ear (3, 4)
- left/right shoulder (5, 6)
- left/right elbow (7, 8)
- left/right wrist (9, 10)
- left/right hip (11, 12)
- left/right knee (13, 14)

Ankles (15, 16) are NOT required. Feet visibility is a bonus but not gating.

The silhouette overlay graphic should be updated to reflect this — show a silhouette from head to roughly mid-shin, not head to feet. Make it clear in the visual that knees-up is enough.

### 2. Replace the "got it" button with a hands-free 5-4-3-2-1 auto-start

Once the upper-body framing condition is satisfied for **1.5 consecutive seconds** (debounce so a transient frame doesn't trigger it), automatically:

1. Show a large countdown overlay on the screen: 5 → 4 → 3 → 2 → 1 → GO
   - Each number visible for ~800ms
   - Big enough to read from across the room (think viewBox-style large numerals, hot pink, centered)
   - Play the existing audible tick from `lib/audio/tick.ts` for each number
2. If during the countdown the user steps out of frame (framing condition breaks for >0.5s), pause the countdown and revert to the silhouette guide — when they step back in, the countdown restarts from 5
3. At GO, dismiss the framing overlay and proceed to whatever the user was originally trying to start (Mode A or Mode B)
4. Save `framing_calibrated: true` to localStorage as today — but the auto-start is what dismisses the screen, not a tap

### 3. Keep a "skip" link as a tiny escape hatch

Bottom-left, small, low-contrast text: "skip". Same as today. Some users will be in weird lighting and just want to bypass.

### 4. Update copy

- Title: "step back so we can see you"
- Subtitle: "knees up is enough — dance starts automatically when you're framed"
- Remove any mention of "press got it when ready" or similar tap-to-continue language

## Where this lives in code

- `app/onboarding/frame-check/page.tsx` — the screen itself
- `components/SilhouetteOverlay.tsx` (or wherever the silhouette graphic is) — update to knees-up shape
- `lib/pose/framingCheck.ts` (or inline if no separate file) — change the joint set + add the 1.5s debounce + countdown state machine
- Re-use `lib/audio/tick.ts` for countdown audio

## What NOT to change

- Do NOT touch the pick-a-dancer screen / multi-person detection. That's working as intended — hearts2miraaa correctly skipped the picker because only 1 lead dancer was detected.
- Do NOT change the mid-session "step back" toast in Mode B. That's separate.
- Do NOT change the framing screen's confidence threshold (0.5) or the silhouette tolerance — only the *joint set* and the *gating mechanism*.
- Do NOT change the Mode A / Mode B start-overlay countdown that fires AFTER framing. This new countdown happens at the framing-check screen specifically.

## Acceptance test

1. Clear localStorage (so framing_calibrated is unset).
2. Tap hearts2miraaa → land on framing-check screen.
3. Sit close to phone — silhouette should be RED/empty (you're too close, head fills frame but no full upper body).
4. Stand back 4-5 feet so the camera sees you from head to knees → silhouette turns hot pink → after 1.5s, countdown begins (5, 4, 3, 2, 1, GO) with audible ticks.
5. During the 5-4-3-2-1, step out of frame deliberately → countdown should pause/reset to silhouette guide.
6. Step back in → countdown restarts from 5.
7. Let it complete → framing screen dismisses, lands on Mode A or Mode B start.
8. Tap hearts2miraaa again next session → should skip framing-check entirely (localStorage flag set).

## Hard rules

1. Hands-free completion is the entire point. Do NOT leave a "got it" button as the primary CTA. Auto-start is mandatory; the skip link is the only tap option.
2. The joint set change is mandatory. Do not gate on ankles or feet.
3. Commit as a single commit: `fix: hands-free upper-body framing gate with 5-4-3-2-1 auto-start`.
4. Update RUNTIME_VERIFICATION.md to note the new framing behavior.

Begin.