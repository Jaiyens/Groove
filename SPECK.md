SPEC: Round 4 — mirror consistency + side-by-side Gemini composition
Hold this spec until motion-onset diagnosis returns
Round 4 depends on the motion-onset diagnosis from the motion-onset-diagnosis branch landing first. The reason: side-by-side composition requires the same client-side video pipeline (canvas + MediaRecorder + ffmpeg.wasm or equivalent) that motion-onset uses. If diagnosis shows that pipeline is fundamentally broken on the target device, this spec has to be rewritten for server-side composition. Do not start this spec until diagnosis lands and is read.
Once diagnosis is in: if the fix is "client-side bug, here's the patch," send this spec. If the fix is "abandon client-side video processing, move to server-side," stop and tell the user before we adapt.

Context — read this before touching files
Round 3 landed: mirror flip for Gemini reference, motion-onset trim (broken on real devices per round 4 diagnosis), headline = mean of components, binary+quantitative canary with component floor 35, tier-capped trouble spots, callout STOP+FLAG on saturated similarity.
Validation on real device surfaced two new problems beyond the motion-onset bug:

Mirror inconsistency across surfaces. Mode A's REF panel is mirrored by default (correct — beginners need same-side correspondence). The holding screen's side-by-side panel is NOT mirrored (the right-hand panel shows mirrored attempt next to unmirrored reference — confusing). Gemini's REF input IS mirrored per round 3. Three surfaces, two different mirror states. Need one global toggle, defaulted ON, that affects all three.
Gemini's two-video architecture is doing more work than it needs to. Currently Gemini receives REFERENCE then ATTEMPT as two separate inline videos and is asked to mentally align them in time and grade the comparison. Tonight's logs show Gemini failing to align — on a sincere attempt it returned overall_score:15 with trouble spots referencing the whole 7-second window because it couldn't tell which parts of the attempt corresponded to which parts of the reference. The fix is structural: send Gemini a single composite video with reference on the left half, attempt on the right half, audio-synced to the reference track. Timing alignment is baked in, the comparison is visual instead of inferential, and the payload is roughly half the size.

The architecture stays — MediaPipe live callouts during, Gemini post-attempt verdict, MediaPipe fallback on Gemini failure. The composite video is just a better INPUT to the Gemini step.

Hard rules

Architecture unchanged at the boundaries. MediaPipe live, Gemini post-attempt, MediaPipe fallback.
All diagnostic logging from rounds 1, 2, 3 stays. Add to it.
Branch off scoring-round-3 (after motion-onset-diagnosis is merged into it) into scoring-round-4. One commit per group. Do not push to main.
Do not modify the canary logic, the component floor, the trouble-spot caps, the tier mapping, or the displayedOverall math from round 3. Those are validated.
Mobile-first. Verify at 390px.
If client-side composition fails on the test device, fall back to the current two-video approach. Do NOT show a hard error to the user. Do NOT fall back to MediaPipe-only.
All four component scores (arms/legs/body/timing) remain in the output schema. The new composite prompt grades them the same way, just from a different visual input.


File-by-file plan
Five groups, in order. Pause for a diff summary after each.

Group 0 — Mirror consistency across all three surfaces
Why first: every downstream surface (Mode A REF panel, holding-screen REF panel, Gemini composite REF half) needs to read the same mirror state. Without a unified source of truth, the side-by-side composition in Group 2 will inherit the current inconsistency and bake it into the composite video.
NEW: lib/preferences/mirror.ts
typescriptconst KEY = 'groov_mirror_enabled';

export function getMirrorEnabled(): boolean {
  if (typeof localStorage === 'undefined') return true; // SSR default
  const v = localStorage.getItem(KEY);
  return v === null ? true : v === 'true';
}

export function setMirrorEnabled(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(KEY, String(enabled));
  window.dispatchEvent(new CustomEvent('groov:mirror-changed', { detail: enabled }));
}

export function onMirrorChanged(handler: (enabled: boolean) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent).detail);
  window.addEventListener('groov:mirror-changed', listener);
  return () => window.removeEventListener('groov:mirror-changed', listener);
}
Default: ON. Single source of truth for all surfaces. Toggle dispatches a custom event so the holding-screen and Gemini client can re-read on change without prop-drilling.
MODIFIED: Mode A REF panel (find with grep -r "scaleX(-1)" app/dance — it lives wherever Mode A renders the reference video)
Replace any hardcoded transform: scaleX(-1) on the REF video with a state-driven version that reads from getMirrorEnabled() on mount and subscribes to onMirrorChanged. The skeleton overlay canvas on the REF panel must apply the same transform — already required from prior work, just make sure it reads from the same source.
MODIFIED: Holding-screen REF panel (find the side-by-side component the user described — probably components/HoldingScreen.tsx or similar)
The REF panel on the holding screen is currently NOT applying a mirror transform. Fix: apply the same transform: scaleX(-1) driven by getMirrorEnabled(). The attempt-side panel is already mirrored by the front-camera — do NOT add another flip to it.
MODIFIED: lib/scoring/gemini/client.ts
The trimReferenceClientSide function currently always flips the canvas (round 3 ff78c62). Change it to read getMirrorEnabled() and apply the flip conditionally. Add to the payload field referenceMirrored: <boolean> based on actual state, not hardcoded true. Update the prompt branch accordingly — the prompt already has a referenceMirrored: true/false switch from round 3.
MODIFIED: Settings panel (wherever the existing mirror toggle in Mode A lives — there should be one)
Migrate the existing per-screen toggle to call setMirrorEnabled(). If no toggle exists yet, add one to the Mode A controls bar with a flip-horizontal icon.
Acceptance:

Flipping mirror in Mode A immediately flips both the Mode A REF panel and (if you then advance to the holding screen) the holding screen REF panel.
Composite video sent to Gemini reflects the same mirror state.
Default state is mirror-on on first load (verify by clearing localStorage).
Toggle persists across reloads.


Group 1 — Composite video rendering (client-side)
Why this is the riskiest group: the canvas + MediaRecorder pipeline is the same one that's been silently failing for motion-onset. If motion-onset diagnosis surfaced a specific cause (e.g., setTransform conflict with MediaRecorder, NaN duration on streaming blob, mobile Safari MediaRecorder bugs), apply the lessons here. If diagnosis revealed the pipeline can't be salvaged client-side, abort this group and we'll respec for server-side.
NEW: lib/scoring/gemini/composite.ts
A renderSideBySideVideo({referenceUrl, attemptBlob, mirror, motionOnsetRefSec, motionOnsetAttemptSec}): Promise<{blob: Blob; mimeType: string} | null> function. Returns null on failure (graceful — the caller falls back to two-video mode).
Algorithm:

Open both videos as hidden <video> elements. Verify both have valid duration (not NaN, not 0). If either fails, return null and log [composite] open failed.
Seek both to their respective motion-onset starts.
Create a canvas, dimensions 1280×720 (16:9). Reference draws to left half (640×720). Attempt draws to right half (640×720). Each source is letterboxed to fit, not cropped — preserve aspect ratio with black bars if needed.
The reference video element provides the audio track. The attempt video's audio is muted (attempt.muted = true).
Use requestAnimationFrame to drive a render loop at 30 fps. On each frame:

Read currentTime from both videos. If either has ended, stop the render.
Draw reference to left half (with setTransform for mirror state per Group 0).
Draw attempt to right half (NO additional mirror — attempt is already mirrored by camera).
Optionally overlay a 1px white divider down the middle for visual clarity.


Capture the canvas stream via canvas.captureStream(30). Add the reference's audio track to the stream via MediaStreamTrack from the reference element's captureStream().
Pipe the combined stream into MediaRecorder with mimeType: 'video/webm;codecs=vp9,opus'. Start both videos playing in sync via Promise.all([ref.play(), att.play()]).
When both videos reach the end (or the shorter one ends), stop MediaRecorder. Return the resulting Blob.
Cleanup: revoke object URLs, remove hidden elements.

Add detailed logging at every step using prefix [composite]. Log: video opens, durations, motion-onset starts used, frame count rendered, MediaRecorder events (start, dataavailable, stop, error), total elapsed ms, output blob size.
MODIFIED: lib/scoring/gemini/client.ts
The current flow trims reference and attempt separately and sends two videos. New flow:

Run motion-onset detection on both videos (existing code).
Try composite path: call renderSideBySideVideo. If it returns a blob, send THAT to the API as a single video. Set a new payload flag compositeMode: true.
Fallback path: if composite returns null, fall back to current two-video approach (trim ref + send both). Set compositeMode: false. Log [gemini-client] composite failed, falling back to two-video.

MODIFIED: app/api/score-gemini/route.ts
Accept either {compositeVideoBase64, compositeMimeType, compositeMode: true} OR {referenceVideoBase64, attemptVideoBase64, ..., compositeMode: false}. Branch on compositeMode and build the Gemini contents array accordingly:

Composite mode: single inlineData part with the composite video.
Two-video mode: existing two inlineData parts.

Log compositeMode and compositeVideoBase64.length (if composite) for diagnostics.
Acceptance:

Composite video plays correctly when downloaded and inspected (reference left, attempt right, reference audio, both moving in sync from t=0 of dance start).
Composite blob size is roughly equal to one of the original videos, not double (the side-by-side composition compresses about as well as a single video).
On a device where composite succeeds, payload contains compositeMode: true and a single video.
On a device where composite fails (force by passing bad inputs), payload falls back to compositeMode: false with two videos and no user-visible error.


Group 2 — Composite prompt rewrite
Why second: the prompt has to match the input format. The current prompt assumes two separate videos. The composite prompt is grading left vs right of a single video.
MODIFIED: lib/scoring/gemini/prompt.ts
Add a compositeMode: boolean parameter. When compositeMode: true, generate a NEW prompt body. When false, fall back to the existing two-video prompt (preserved for the fallback path).
The new composite prompt:
You are a dance teacher grading a student's attempt at a TikTok dance.

You will receive ONE video showing two performances side by side:
- LEFT half: the REFERENCE dancer (the choreography to be matched)
- RIGHT half: the STUDENT's ATTEMPT

Both halves play in perfect time sync. The audio is from the REFERENCE track. Both performances start at the first beat of the choreography — there is no pre-roll, no walking-back-to-camera, no warmup.

The reference has been horizontally mirrored so that left/right correspond directly to the student's attempt (which is captured from a front-facing camera). When the reference's left arm goes up, the student's left arm should go up — they should look like mirror images of each other on the same side of the screen.

STEP 1 — DECIDE is_actually_dancing.

The attempt is NOT a dance attempt if any of the following are true while watching the RIGHT half of the video:
(a) the body is mostly still relative to the camera (postural sway only)
(b) the limb motion is fast but uncorrelated with the LEFT half (the student is flailing, not copying)
(c) the student is out of frame for more than 30% of the video

If any of these are true, set is_actually_dancing: false AND set overall_score to a value between 5 and 25. Components should reflect what was actually observed on the RIGHT half. Do not pad upward.

STEP 2 — SINCERE ATTEMPT SCORING.

If is_actually_dancing: true, grade four components 0-100 by comparing the RIGHT half to the LEFT half:
- ARMS: how closely the student's arm shapes, positions, and motion match the reference's
- LEGS: how closely the student's leg motion matches. If legs are not visible on the RIGHT half (upper-body framing), set legs: null. Do NOT impute a default.
- BODY: how closely the student's torso isolations, weight shifts, and overall body engagement match
- TIMING: how aligned in time the student's beats are with the reference's. Since both halves play in sync, you can directly see whether a movement on the RIGHT lags or leads the corresponding movement on the LEFT.

No individual sincere-attempt component may be below 35 unless the student genuinely showed zero effort on that axis.

STEP 3 — TROUBLE SPOTS, CAPPED BY TIER.

Pick the most important moments where the student diverges from the reference. Reference timestamps within the video (e.g., 0:02-0:03). Each trouble spot has body_part, severity, what_happened, fix.

Counts capped by tier:
- GROOVY (85-100): max 2 trouble spots
- SOLID (65-84): max 3
- SHAKY (40-64): max 4
- NOT_DANCING: exactly 1, saying "this didn't look like an attempt at the dance"

DO NOT include trouble spots about:
- Hand shape details (thumb up vs palm flat) — these are execution noise
- Subtle body isolations the student missed when the main move was correct
- The first or last 200ms (compression artifacts)

STEP 4 — INSIGHTS.

If is_actually_dancing: true, return 2-4 insights. The FIRST insight must be a specific, positive observation about what the student did well. Subsequent insights are actionable corrections.

If is_actually_dancing: false, return 1-2 insights. Do NOT fabricate praise. Acknowledge the attempt wasn't a copy of the choreography and suggest watching the reference first.

Return ONLY valid JSON matching the schema. No prose, no markdown.
MODIFIED: tests/geminiPrompt.test.ts
Add a new test block for compositeMode: true. Assert:

The "ONE video showing two performances side by side" sentence is present
"LEFT half" and "RIGHT half" language is present
The "horizontally mirrored... look like mirror images" clause is present
The canary trip conditions (a)(b)(c) reference "the RIGHT half"
All Group 4 (round 3) invariants — floor of 35, legs: null, tier-capped trouble spots, conditional positive-first insights — are present in the new prompt

Keep all existing compositeMode: false tests intact (they verify the two-video fallback prompt).
Acceptance:

All 225+ round-3 tests still pass.
New composite-mode tests pass.
Manual: dump the actual prompt being sent on a composite-mode attempt and read it end-to-end for grammar and clarity.


Group 3 — Wire composite mode through the orchestration
Why third: Groups 0-2 build the pieces; this group connects them and makes one real composite attempt actually flow end-to-end.
MODIFIED: the Mode B test page orchestrator (find with grep -r "scoreWithGemini" app/dance)
Add a feature flag NEXT_PUBLIC_COMPOSITE_MODE_ENABLED=true (default true for the validation pass; can be flipped to false to revert to two-video without code changes). When the flag is on, the orchestrator calls the new composite path. When off, the existing two-video path.
The flag also gets logged: [gemini-client] composite mode flag: <true|false>.
Acceptance:

With flag on, one sincere attempt produces a composite video, sends it to Gemini, returns a valid score that reflects the new prompt.
With flag off, the existing two-video path still works unchanged.
Toggle requires only a .env.local change, no code edit.


Group 4 — Validation gate doc
NEW: docs/round-4-validation.md
Write the five-attempt validation protocol for the user to follow. Same five attempts as round 3 (sincere, standing still, flailing, different chunk, off-beat) but with composite-mode-specific things to watch for:

Sincere attempt: does the composite video render? Check the terminal for [composite] logs showing frame count, duration, blob size. Does Gemini score it 55-85 with components in the 35-95 range?
Standing still: composite still renders (the right half is just a still person). Gemini canary should fire — is_actually_dancing: false, overall 5-25.
Flailing — the hard canary. This is the test side-by-side is supposed to be better at. With both halves visible to Gemini at the same time, it should be obvious the right half isn't doing what the left half is doing. Overall must score under 25. If it doesn't, side-by-side did not solve the canary problem and we have a deeper issue with Gemini's vision.
Different chunk: sanity check.
Off-beat: with timing baked into the composite, Gemini should now flag timing far more accurately than in two-video mode. Watch for timing component to drop while other components stay normal.

Plus one composite-specific check:
6. Force composite failure (e.g., pass a bad attempt blob in dev tools) and verify the two-video fallback fires silently. User should not see an error.

Out of scope

Server-side composition (if motion-onset diagnosis says we have to go this route, separate spec).
Changes to MediaPipe live callouts. The saturated-similarity rewrite from round 3's STOP+FLAG is its own future spec.
Changes to Mode A beyond the mirror-toggle plumbing.
Replacing the trouble-spot tier caps or component floor from round 3.


Working agreement

Pause for a diff summary after each group.
Mobile-first. 390px.
All round-1/2/3 logging stays. Add [composite] and [gemini-client] composite ... prefixes.
If Group 1's MediaRecorder pipeline fails on the test device the same way motion-onset failed, STOP and flag. We move to server-side composition in a separate spec.
One commit per group. Branch scoring-round-4. No push to main.


Acceptance summary (all must pass)

 Mirror state is unified across Mode A REF, holding-screen REF, and Gemini REF input via groov_mirror_enabled localStorage key.
 Default mirror state is ON; toggle persists; all three surfaces respect it.
 Composite video renders successfully on the test device.
 Composite payload has compositeMode: true and a single video.
 Composite prompt rewrite is in place; all round-3 invariants preserved; new tests assert composite-specific language.
 Sincere attempt scores 55-85 with components in 35-95.
 Flailing scores under 25 — hard canary, do not tune around if it fails.
 Standing still scores under 25.
 Composite failure falls back silently to two-video; user sees no error.
 All round-1/2/3 tests still pass.
 Branch scoring-round-4 pushed, no merge to main.