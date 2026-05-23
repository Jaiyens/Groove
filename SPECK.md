SPECK.md — Generosity Rewrite + Callout UI + Failure Visibility
Context — read this first
The previous PR (gemini-windowing-fix) landed cleanly. Reference trimming works (~2.1MB / ~7.4s instead of ~5MB / ~15s), trouble spot timestamps stay within attempt bounds, leg-visibility branch routes correctly. The plumbing is correct.
But validation revealed the scoring itself is wrong, in three specific ways:

The numbers are too low and the tone is too harsh. A sincere attempt scored 47. The same dance with bigger motion scored 61. Random flailing scored 50. Trouble spots are padded (4-5 per attempt regardless of severity), tagged MAJOR for minor issues ("started 0.5s late" ≠ catastrophic), and use punitive adjectives ("very small," "significantly delayed," "completely missed"). The system feels mean, and the numbers don't track reality.
The canary partially fails. Standing still correctly scores 5 (Gemini sees no motion → is_actually_dancing: false). But random flailing scored 50 with is_actually_dancing: true — Gemini hallucinated specific moves the user "attempted." The prompt's generosity language is so strong that any motion gets graded as a sincere attempt.
Gemini fails silently and you don't know. One sincere attempt produced a 32 with "FALLBACK SCORING" — meaning Gemini failed and MediaPipe took over without any visible reason logged. The fallback architecture works as designed, but we have zero observability into why Gemini failed.

This PR fixes all three. Plus a Just Dance-quality callout UI redesign that was previously deferred. Plus diagnostic logging on the live-callout engine because every callout currently fires GROOVY regardless of attempt quality.
Branch off the latest gemini-windowing-fix (or main if merged) into gemini-generosity-and-ui.

Hard rules

The architecture stays: MediaPipe live callouts during, Gemini final verdict after, MediaPipe fallback on Gemini failure. No structural changes.
All diagnostic logging from previous rounds stays. Add to it, don't remove.
Branch: gemini-generosity-and-ui. One commit per file group. Do not push to main.
Do not modify the chunk-windowing logic from the previous PR — it's correct.
Mobile-first: verify at 390px.


File-by-file plan
MODIFIED: lib/scoring/gemini/prompt.ts (the biggest change)
Rewrite the prompt. The current version's "be generous" language is too vague — Gemini interpreted it as "give benefit of the doubt to any motion." The new prompt is more precise: it raises the floor for sincere attempts, redefines what "sincere" means (stricter), recalibrates severity (most things should be MINOR), caps trouble spot counts proportional to score, and requires the first insight to be a positive specific observation.
Replace the entire function body with:
typescriptexport function buildGeminiPrompt(args: {
  legsVisible: boolean;
  referenceChunkStartSec: number;
  referenceChunkEndSec: number;
}): string {
  const { legsVisible, referenceChunkStartSec, referenceChunkEndSec } = args;

  return `You are a supportive dance teacher grading a student's attempt at a SINGLE CHUNK of a TikTok dance. Your job is to help the student improve, not to nitpick. Lead with what worked, then constructively note what to improve.

VIDEOS
You will receive two videos in order: REFERENCE, then ATTEMPT.
The ATTEMPT is captured from a front-facing camera and is mirrored. Grade it as a mirror copy — when the reference dancer's left arm goes up, the attempt's right arm going up is CORRECT.

CHUNK CONTEXT
The reference is a short chunk of a longer dance, not a complete routine. The actual choreography to grade against is between ${referenceChunkStartSec.toFixed(2)}s and ${referenceChunkEndSec.toFixed(2)}s of the reference video. Anything before or after is padding — the dancer settling in or recovering. IGNORE THE PADDING.

The attempt video may be longer than the choreography window — the user has natural lead-in (preparing to dance) and lead-out (finishing, walking back to camera). IGNORE THOSE TOO. Score only the user's attempt to perform the choreography in the reference window. DO NOT report trouble spots past the end of the reference choreography.

WHAT COUNTS AS THE DANCE
The dance is the deliberate, repeatable choreography — the hits, the arm patterns, the steps, the body movements that are clearly choreographed.

IGNORE incidental motion in the reference:
- The dancer walking into frame or pressing play
- Casual swaying while the music starts
- Drifting toward or away from the camera between moves
- Settling into position or relaxing after the final hit
- Natural body micro-movements between choreographed counts
These are setup and recovery, NOT choreography. Do NOT penalize the user for not replicating them.

PERSONAL STYLE IS NOT AN ERROR
The user may execute the choreography with their own angle, energy, or flourish. If the core move is recognizable, that is SUCCESS. Score down only for missing or incorrect choreography — not for stylistic variation. Smaller motion executed correctly beats bigger motion executed incorrectly.

${legsVisible
  ? 'LEGS: The user has their legs in frame. Score legs normally as part of the choreography.'
  : 'LEGS: The user is filming UPPER BODY ONLY — legs are not in frame. This is a framing choice, not a performance error. Score the legs component at 75 by default and do NOT let leg-related issues affect overall_score. Do NOT include leg-related trouble spots. Focus your trouble spots on arms, body, and timing.'}

SCORING — RAISE THE FLOOR FOR REAL ATTEMPTS
This is a HARD RULE. If the user is sincerely attempting the choreography — even badly, even with most moves wrong — the overall_score MUST be at least 50.

A "sincere attempt" means: the user is performing recognizable choreographed moves in approximate sequence, with at least some timing relationship to the music. NOT just "any motion is happening." Random arm-waving with no relation to the reference is NOT a sincere attempt.

Three zones, no exceptions:
- **0-39: Not attempting.** Standing still, off-camera, or motion completely unrelated to the choreography (random flailing).
- **40-49: Attempting but very poor.** Motion is present and some timing relation to the music exists, but few or no specific reference moves are recognizable.
- **50-100: Sincere attempt.** User is performing recognizable moves from the choreography, even if execution is imperfect. Floor is 50, no exceptions.

Within 50-100, calibrate:
- **50-64 SHAKY:** Some moves recognizable but many missed, wrong, or significantly off-beat.
- **65-84 SOLID:** Most moves recognizable, mostly on beat, execution mostly correct.
- **85-100 GROOVY:** All major moves hit, on the beat, full performance energy.

CANARY (this still applies)
If is_actually_dancing is false, overall_score MUST be below 40. Standing still → score 0-15. Random flailing with no choreography match → score 25-39.

SEVERITY CALIBRATION
Trouble spots have severity levels. Use them PROPORTIONATELY. Most issues should be MINOR. MAJOR should be rare.

- **MAJOR:** The user completely skipped a move or did a totally different move in its place. Reserved for big, obvious failures.
- **MODERATE:** The user did the move but with the wrong direction, wrong arm, or 1+ beats off the music.
- **MINOR:** The move is recognizable but execution wasn't crisp — slightly off angle, slightly small, slightly delayed.

If you're tempted to call something MAJOR but it's just "not quite right," it's MINOR. If you're tempted to call something MODERATE but the user clearly attempted it and got close, it's MINOR.

TROUBLE SPOT COUNT — DO NOT PAD
Match the count to how poorly the user actually did. DO NOT generate the maximum just to fill the list.

- **overall_score 0-39:** 1-3 trouble spots. For non-attempts, ONE summary trouble spot is enough.
- **overall_score 40-64:** 2-3 trouble spots. Pick the most important.
- **overall_score 65-84:** 1-2 trouble spots. The user did mostly well — only call out the top issues.
- **overall_score 85-100:** 0-1 trouble spots. The user nailed it. Maybe one tiny polish note.

If a trouble spot is MINOR, ask yourself if it's worth including at all. Most MINOR issues should just be omitted.

INSIGHTS — TONE MATTERS
1-4 insights. The FIRST insight MUST be a specific positive observation about what the user did well. Not generic ("good effort") — specific ("you nailed the arm extension on the second beat"). If you genuinely cannot identify anything positive (only true for non-attempts under 40), say "You showed up and tried — that's the first step." and move on.

Subsequent insights are constructive but PROPORTIONATE. Avoid these adjectives unless the issue is truly extreme: "very," "significantly," "completely," "entirely," "totally," "barely," "not at all." Instead use proportionate language: "slightly," "a bit," "could be sharper," "try to extend a little more."

Insights should be ACTIONABLE — tell the user what to do differently, not just what was wrong.

OUTPUT
Return ONLY valid JSON matching the schema. No prose, no markdown, no commentary.`;
}
Acceptance: Test cases in tests/geminiPrompt.test.ts must verify:

"Floor is 50" language present
"is_actually_dancing: false → score below 40" present in both leg-visibility branches
Severity calibration paragraph present
Trouble spot count cap language present
"first insight must be positive" language present
"personal style is not an error" present
"smaller motion executed correctly beats bigger motion" present
All padding-ignore clauses preserved from previous version

MODIFIED: app/api/score-gemini/route.ts
Add retry-once before fallback and failure visibility logging.
Current behavior: one call to Gemini, parse, return success or {error} with status 502.
New behavior:

Call Gemini.
On any failure (network error, timeout, schema validation, JSON parse failure), log the specific failure reason with [gemini-score][failure] prefix, then retry exactly once.
If retry also fails, log [gemini-score][fallback] with the failure reason, return 502 (existing fallback path takes over).
Failure reasons must be specific and distinct in logs: timeout, network, schema_validation, json_parse, upstream_5xx, upstream_4xx, unknown.

Edge cases:

Total latency budget: still 30s for the route. If retry would exceed remaining budget, skip retry and go straight to fallback.
Do NOT retry on 4xx upstream errors (those mean our request is malformed, retrying won't help).
Preserve all existing [gemini-score] logs from previous rounds. ADD to logging, don't replace.

Acceptance: Force a Gemini failure (kill network, malform request, mock the SDK). Verify the terminal shows the failure reason, the retry attempt, and either retry-success or final-fallback logs. End-user behavior unchanged on the surface (fallback still silent to UI).
MODIFIED: lib/scoring/gemini/client.ts
Browser client may need to handle the case where the API route returns 502 after retry. Verify the existing behavior gracefully returns { kind: 'error', reason: string } on 502.
If the current implementation doesn't gracefully handle a 502 response, fix it so it returns { kind: 'error', reason: 'gemini_failed_after_retry' } cleanly within 1s, no throw.
Acceptance: When the API route returns 502, the browser client returns a tagged error within 1s, no throw.
MODIFIED: components/scoring/CalloutOverlay.tsx — UI redesign
Currently the callout overlay renders generic 64px text centered on screen, over the user's face. Almost every callout fires GROOVY. Two problems to fix together.
Visual redesign:

Position: bottom center, above any controls. Vertically: ~80% down the viewport. Horizontally: centered.
Size: 64px on mobile (don't shrink, just move).
Typography: use a heavy display font face. Add to the project (or use a Google Font import): Bungee, Anton, or Archivo Black — pick one with character. Heavy weight, condensed, all caps, tight letter-spacing (-0.02em), slight italic skew (-3deg).
Per-tier visual treatment:

GROOVY: brand pink #FF1F8E, white outer stroke (4px), radial pink glow (filter: drop-shadow), subtle particle burst on entry (3-5 small pink/white dots radiating outward, fade in 200ms then fade out 400ms). This is the "you nailed it" celebration.
PERFECT: white fill, pink outer stroke (3px), no glow, no particles. Clean and crisp.
GREAT: white fill, white outer stroke (1px), no glow. Minimal.
ALMOST: muted slate #94A3B8, no stroke, no glow. Quietly visible — present but not punishing.


Animation per tier:

GROOVY: scale from 0.6 → 1.15 → 1.0 with overshoot (cubic-bezier(0.34, 1.56, 0.64, 1)) in 200ms, hold 500ms, fade out 300ms. Plus a brief 2-frame shake on the apex (rotate -2deg then +2deg).
PERFECT: scale from 0.7 → 1.1 → 1.0, 180ms in, hold 450ms, fade out 250ms.
GREAT: scale 0.8 → 1.0, 150ms in, hold 400ms, fade out 250ms.
ALMOST: opacity 0 → 0.7 → 0, no scale, 800ms total. Subtle.


Z-index: above skeleton overlay (z-10), below results (z-40). Use z-20.
Pointer-events: none.
No sound. Sound design deferred to future spec.

Use a single positioned div for the text with the active tier's style. For particles on GROOVY, render a brief inline SVG or canvas with absolute-positioned dots that animate outward.
Acceptance:

Mobile 390px view: callout sits at ~80% viewport height, centered.
Each tier visibly looks different — not just the text color.
GROOVY has particles on entry; others don't.
Animation feels snappy, not laggy. Compare side-by-side in a dev panel that fires one of each.

MODIFIED: lib/scoring/callouts/calloutEngine.ts
The "everything fires GROOVY" bug. Add diagnostic logging to find the root cause, then tune.
Diagnostic logging:
Inside the per-beat fire logic, add:
console.log(`[callout-engine] beat=${beatIndex} timestamp=${timestamp.toFixed(0)}ms windowMaxSimilarity=${windowMax.toFixed(3)} tier=${tier}`);
This will let the human see per-beat similarity values in the terminal during an attempt. Expected: for a sincere attempt, values mostly in the 0.5-0.85 range. If every beat is logging 0.9+ (firing GROOVY every time), there's a normalization bug elsewhere.
Threshold tuning:
If logs reveal similarity is consistently inflated, lower the thresholds:

Current: >= 0.88 → GROOVY, >= 0.75 → PERFECT, >= 0.60 → GREAT, < 0.60 → ALMOST
If logs show real attempts at 0.7-0.9: raise to >= 0.92 → GROOVY, >= 0.82 → PERFECT, >= 0.68 → GREAT

If logs show real attempts in expected range (0.5-0.85): keep thresholds, the bug is elsewhere (possibly in the per-frame similarity, possibly in window-max picking outliers).
DO NOT silently re-tune without seeing the logs first. The fix here depends on what the data says. Run one attempt, inspect the logs, then make the call.
Acceptance: A real attempt produces a mix of tiers in the terminal logs (not all GROOVY). After tuning if needed, sincere attempts produce mostly PERFECT/GREAT with occasional GROOVY peaks and rare ALMOST.
MODIFIED: components/ResultsCard.tsx
Two small changes:

Tier label rendering. When the score is 50-64, the SHAKY tier currently shows "WAS THAT A DANCE?" (which is fine for sub-40). For 50-64 SHAKY, change the headline to something supportive. Match the headline to the tier:

0-39: "WAS THAT A DANCE?" (existing)
40-49: "JUST TRYING?" (new)
50-64 SHAKY: "GETTING THERE." (new)
65-84 SOLID: "NICE WORK." (new)
85-100 GROOVY: "GROOVY!" or "YOU GOT IT." (new)


Score color. Currently the score is always red. Change color by tier:

0-39: red (#EF4444)
40-64: orange/amber (#F59E0B)
65-84: yellow-green (#A3E635)
85-100: brand pink (#FF1F8E)



Acceptance: At 47.5, the headline reads "JUST TRYING?" and the score is amber. At 75, reads "NICE WORK." and is yellow-green.

What this PR does NOT do (deferred)

Video alignment / MediaRecorder delay fix. Hypothesized but no clear data yet. If after these fixes the user still reports "I was on beat but it says I wasn't," that's the next investigation.
Skeleton size normalization between user and reference. Was a red herring — Gemini doesn't see the skeleton. May still be worth doing for visual quality of the dual-skeleton overlay, but separate concern.
Side-by-side analysis loading screen (reference + attempt). Saved for next spec.
Analysis pipeline — Gemini analyzes each library dance into named moves with timestamps. Saved for next spec.
Knowledge graph foundation. Saved for next spec.
Sound design for callouts. Future.
Adaptive recommendations / progression / curriculum logic. Future.


Working agreement

Pause after each file group, post a diff summary.
Flag conflicts with existing code before silently restructuring.
If prompt rewrite causes existing snapshot tests to break, update the snapshots — the prompt changing is the point.
Verify on mobile 390px viewport before considering UI changes done.


Acceptance summary (all must pass before PR is ready)

 Prompt updated with floor-50 language, severity calibration, count caps, positive-first insight, proportionate adjectives.
 Sincere attempt on chunk 1 scores ≥60 (validation target — was 47).
 Sincere bigger-energy attempt does NOT score significantly higher than sincere accurate attempt (energy bias reduced — accurate small > inaccurate big).
 Standing still still scores <20 (canary intact).
 Random flailing scores 25-39 (canary partially fixed — flailing not "trying").
 Trouble spot counts respect score brackets (≥65 → max 2; 85+ → max 1).
 First insight on any score ≥40 is a specific positive observation.
 No punitive adjectives ("very," "significantly," "completely") in insights when score ≥50.
 API route retries once on Gemini failure, logs failure reason, logs fallback.
 Callout overlay appears bottom center, not on face.
 Each tier (GROOVY/PERFECT/GREAT/ALMOST) visibly distinct — color, font, motion.
 GROOVY has particle burst on entry.
 Callout engine logs per-beat similarity; mix of tiers fires on real attempt (not all GROOVY).
 Results card headline and score color match tier.
 All existing tests pass.
 Branch gemini-generosity-and-ui pushed locally, not merged.