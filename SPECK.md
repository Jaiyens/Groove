# SPECK.md — Deterministic Scoring + Side-by-Side Holding Screen + Callout Investigation

## Context — read this first

Validation of the previous PR (`gemini-generosity-and-ui`) revealed three things:

**What's working:**
- Canary is solid. Standing still scores 10, hands-up flailing scores 30. Both correctly tagged `is_actually_dancing: false`. The Gemini signal is reliable enough to be the foundation of further scoring logic.
- Energy bias is eliminated. Sincere attempt = 55. Same attempt with 300% energy = 55. The prompt fix worked.
- UI tier-matched headlines and colors render correctly.

**What's not:**
- Sincere attempts score 55. That's too low for the product to feel rewarding. Users who try will see "GETTING THERE." with a 55 and disengage. We've iterated on the prompt twice trying to push this number up and it barely moves. **We're going to stop fighting the model and compute the displayed score deterministically.**
- Legs default to 75 even when the user isn't dancing. Standing-still results show "75 LEGS" alongside zeros — looks like a UI bug.
- Live callouts always fire GROOVY. Previous spec added diagnostic logging but no `[callout-engine]` lines appeared in terminal logs during validation. The engine may not be running at all, or the logging is on the wrong path. Needs real investigation, not tuning.
- The holding screen still shows only the user's attempt with skeleton overlay. The user asked two specs ago for a side-by-side with the reference video. It was deferred. Shipping it now.

This PR addresses all four. Branch off the latest `gemini-generosity-and-ui` (or main if merged) into `gemini-deterministic-and-sidebyside`.

---

## Hard rules

1. Architecture stays the same. We're adding a deterministic scoring layer on top of Gemini, not replacing Gemini.
2. Gemini's `overall_score` becomes an internal debug field. It is logged but never displayed.
3. All diagnostic logging from previous rounds stays.
4. Branch: `gemini-deterministic-and-sidebyside`. One commit per file group. Do not push to main.
5. Mobile-first: verify at 390px.

---

## File-by-file plan

### NEW: `lib/scoring/deterministic.ts`

The deterministic scoring layer. Takes Gemini's structured output and computes the displayed score using a formula calibrated for product psychology, not measurement accuracy.

```typescript
import type { GeminiScore } from './gemini/types';

export type DeterministicScore = {
  displayScore: number;        // 0-100, what the user sees
  displayTier: 'NOT_DANCING' | 'TRYING' | 'SHAKY' | 'SOLID' | 'GROOVY';
  geminiRawScore: number;      // For debug pill / "why are these different"
  isActuallyDancing: boolean;
  components: {                // What the UI renders
    arms: number;
    legs: number;
    body: number;
    timing: number;
  };
};

/**
 * Computes the displayed score from Gemini's structured output.
 *
 * Design philosophy: Gemini is excellent at qualitative judgment (what happened,
 * what went wrong, what to fix) and unreliable at consistent quantitative scoring.
 * We use Gemini's judgment to drive a deterministic formula that produces
 * psychologically-calibrated scores: sincere attempts feel rewarding, non-attempts
 * still fail the canary.
 */
export function computeDeterministicScore(gemini: GeminiScore, legsVisible: boolean): DeterministicScore {
  // Non-attempt path: trust Gemini's verdict, it's already calibrated correctly
  if (!gemini.is_actually_dancing) {
    return {
      displayScore: clamp(gemini.overall_score, 0, 39),
      displayTier: 'NOT_DANCING',
      geminiRawScore: gemini.overall_score,
      isActuallyDancing: false,
      components: {
        arms: gemini.components.arms,
        legs: 0,  // FIX: legs always 0 when not dancing, ignore the default-75
        body: gemini.components.body,
        timing: gemini.components.timing,
      },
    };
  }

  // Sincere attempt path: deterministic formula
  // Base score: 85 (the "you tried and it was recognizable" score)
  let score = 85;

  // Trouble spot penalties — capped so a long trouble-spot list can't tank the score
  const major = gemini.trouble_spots.filter(t => t.severity === 'major');
  const moderate = gemini.trouble_spots.filter(t => t.severity === 'moderate');
  const minor = gemini.trouble_spots.filter(t => t.severity === 'minor');

  score -= Math.min(major.length, 2) * 5;        // Max -10 from MAJOR
  score -= Math.min(moderate.length, 3) * 2;     // Max -6 from MODERATE
  score -= Math.min(minor.length, 4) * 0.5;      // Max -2 from MINOR

  // Hard bounds for sincere attempts
  score = clamp(score, 70, 98);
  score = Math.round(score);

  return {
    displayScore: score,
    displayTier: scoreToTier(score),
    geminiRawScore: gemini.overall_score,
    isActuallyDancing: true,
    components: {
      arms: gemini.components.arms,
      legs: legsVisible ? gemini.components.legs : 75,  // Upper-body framing: still 75
      body: gemini.components.body,
      timing: gemini.components.timing,
    },
  };
}

function scoreToTier(score: number): DeterministicScore['displayTier'] {
  if (score >= 85) return 'GROOVY';
  if (score >= 75) return 'SOLID';
  if (score >= 70) return 'SHAKY';   // The floor for sincere attempts
  if (score >= 40) return 'TRYING';
  return 'NOT_DANCING';
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
```

**Unit tests at `tests/deterministic.test.ts`:**

- Standing still input (is_actually_dancing: false, overall_score: 10) → displayScore: 10, components.legs: 0, tier: NOT_DANCING
- Flailing input (is_actually_dancing: false, overall_score: 30) → displayScore: 30, components.legs: 0
- Perfect sincere (is_actually_dancing: true, no trouble spots) → displayScore: 85, tier: GROOVY
- Sincere with 1 moderate, 2 minor (tonight's actual data) → displayScore: 82, tier: GROOVY
- Sincere with 3 major + 5 moderate + 5 minor (worst case) → displayScore: clamped to 70 floor, tier: SHAKY
- legsVisible=false sincere → components.legs: 75
- legsVisible=true sincere → components.legs: passes through Gemini value

**Acceptance:** All unit tests pass. The function is pure (no side effects, deterministic for same input).

### MODIFIED: `lib/scoring/gemini/client.ts` and the Mode B orchestrator

Wire `computeDeterministicScore` into the result path.

Wherever `scoreWithGemini` returns success, immediately call `computeDeterministicScore(geminiResult.score, legsVisible)` and pass the `DeterministicScore` (not the raw `GeminiScore`) to the results card.

The `GeminiScore` object is still available for the debug pill — pass it as a separate prop.

```typescript
// In Mode B orchestrator
const geminiResult = await scoreWithGemini({...});
if (geminiResult.kind === 'success') {
  const deterministicScore = computeDeterministicScore(geminiResult.score, legsVisible);
  // Pass deterministicScore as primary, geminiResult.score as raw debug info
}
```

The MediaPipe fallback path needs an equivalent — when Gemini fails entirely and MediaPipe takes over, the MediaPipe score is what shows. No deterministic computation on fallback (we can't trust MediaPipe's `is_actually_dancing` heuristic).

**Acceptance:** Tonight's three test cases produce: sincere → 82, energetic-sloppy → 82, standing → 10, flailing → 30.

### MODIFIED: `components/ResultsCard.tsx`

Update to read from `DeterministicScore` instead of `GeminiScore`. The shape is mostly the same — `displayScore` instead of `overall_score`, `displayTier` instead of `tier`, `components` is the same.

Add a "Gemini raw" line to the debug pill when `SHOW_BOTH_SCORES=true`:
```
MediaPipe (debug): 31  ·  Gemini raw: 55
```

When the user taps "Why are these different?", expand to show all three: Display, Gemini raw, MediaPipe. Educational, also useful for tuning.

**Acceptance:** Display score shows 82 for a sincere attempt where Gemini returned 55. Debug pill shows both numbers in validation mode. Tier badge and color match `displayTier`, not Gemini's raw `tier`.

### MODIFIED: `lib/scoring/gemini/prompt.ts`

Two small surgical additions to reduce noisy MODERATE trouble spots. Don't rewrite the whole prompt — just add these two paragraphs near the SEVERITY CALIBRATION section.

```
HAND AND FINGER DETAILS ARE MINOR
Exact hand shapes, finger configurations, and hand-signal gestures (rock-on, finger guns, peace signs, specific finger curls) are MINOR at worst. Most students will not replicate these exactly and that is fine. Only call out hand details if the user did a completely wrong motion (e.g., reference was hands up, user kept hands down) — and even then, it's MINOR.

EXECUTION QUALITY IS MINOR
Trouble spots about "extension," "crispness," "sharpness," "isolation," "fullness," or "energy of execution" are MINOR. Only escalate to MODERATE if the user did the wrong move entirely (wrong direction, wrong arm, wrong body part) — not if they did the right move with imperfect execution.
```

Update the corresponding tests in `tests/geminiPrompt.test.ts` to verify both new clauses are present in both leg-visibility branches.

**Acceptance:** Tonight's "rock on hand gestures missed" trouble spot would now be tagged MINOR (or omitted) instead of MODERATE. Verify by re-running a sincere attempt and checking the raw response.

### NEW: `components/scoring/SideBySideHoldingScreen.tsx`

Replaces the current `HoldingScreen` component. Shows reference video (left) and user's attempt (right), both playing in sync, both with their respective skeleton overlays.

**Layout (mobile 390px):**
- Two video panels side by side, stacked vertically in a 2-column grid that takes ~60% of the viewport height.
- Each panel is 50% width with the video inside maintaining aspect ratio.
- Reference labeled "REFERENCE" above left video; "YOU" above right video. Small uppercase labels, muted grey.
- Both videos start playing simultaneously when the screen mounts (use `Promise.all` to await both `.play()` calls before starting).
- Both loop until the screen unmounts.
- Both have their skeleton overlay drawn on top.

**Skeleton overlays:**
- **Right (user) panel:** the user's pose track (pink skeleton). This is what's already implemented for the current holding screen — reuse the rendering logic.
- **Left (reference) panel:** the reference dancer's pose track (white skeleton). The reference pose track should be precomputed in the dance library data. If it isn't currently precomputed, fall back to no skeleton on the reference side (just the video) and flag this in the PR — that's a separate data pipeline task, not blocking.

**Below the videos:**
- Rotating status text (same phrases as current holding screen)
- Progress shimmer

**Minimum mount time:** 3 seconds (same as current).

**Acceptance:**
- On a real attempt, both videos appear side by side, both play, both loop, both stay in sync within 100ms drift over 7 seconds.
- User's skeleton draws on right panel.
- Reference skeleton draws on left panel IF reference pose track exists in the dance data — otherwise just the video.
- At 390px viewport, both panels are visible and readable.

### MODIFIED: `lib/scoring/callouts/calloutEngine.ts` AND wherever it's invoked

The callout engine investigation. Previous spec added logging at the tier-decision point but no logs appeared, meaning either (a) the engine isn't running, or (b) the logging wasn't on the active code path.

**Add three layers of logging:**

1. **Initialization log.** In `createCalloutEngine` constructor:
   ```
   console.log('[callout-engine][init] accentBeats=', config.accentBeatTimestamps.length);
   ```

2. **Per-frame ingestion log.** Sample at 1 in 30 frames so we don't flood:
   ```
   if (frameCount % 30 === 0) console.log('[callout-engine][frame] ts=', timestamp, 'similarity=', similarity);
   ```

3. **Per-beat decision log** (already exists, keep):
   ```
   console.log('[callout-engine][beat] index=', beatIndex, 'windowMax=', windowMax, 'tier=', tier);
   ```

4. **Callback fire log.** In the place where `onCallout` is invoked:
   ```
   console.log('[callout-engine][fire] tier=', event.tier, 'at=', event.timestamp);
   ```

**Also add a log at the Mode B integration point** — wherever the callout engine is wired up to the per-frame scoring loop:
   ```
   console.log('[mode-b][callout-wired] engine created');
   ```

The point: after running one attempt, the terminal MUST show at least the `[init]` and `[callout-wired]` logs. If neither appears, the engine isn't being instantiated at all. If `[init]` appears but no `[frame]` logs, the engine is created but never receiving frames. If `[frame]` logs appear but no `[beat]` logs, the beat detection is broken.

This is purely diagnostic for this PR. Do not tune thresholds. The next spec uses this data to fix the actual bug.

**Acceptance:** After running one attempt, terminal shows logs from at least the `[init]`, `[callout-wired]`, and `[frame]` levels. If none appear, document this clearly in `/docs/callout-investigation.md` with what was checked — that itself is the deliverable.

### MODIFIED: `components/ResultsCard.tsx` (small additional change)

When `displayScore >= 85`, the score should render with the pink brand color (`#FF1F8E`) and the headline should say "GROOVY!" with celebration energy. When 75-84 (SOLID), use yellow-green (`#A3E635`) with "NICE WORK." or "YOU GOT IT.". When 70-74 (SHAKY, the new floor zone for sincere attempts), use amber and "GETTING THERE."

This means most sincere attempts will now hit GROOVY or SOLID, which is the *point*.

Test cases for `tests/resultsCard.test.tsx`:
- displayScore 82 → headline "GROOVY!" or equivalent, color pink
- displayScore 78 → headline "NICE WORK.", color yellow-green
- displayScore 72 → headline "GETTING THERE.", color amber
- displayScore 30 → headline "WAS THAT A DANCE?", color red

**Acceptance:** A sincere attempt that produces a deterministic 82 shows pink, large, GROOVY headline. Feels like winning.

---

## What this PR does NOT do (deferred)

- **Callout threshold tuning.** This PR adds diagnostic logging only. Tuning happens after we see what the logs say.
- **Sound design for callouts.** Future.
- **Reference pose track precomputation pipeline.** If reference pose tracks aren't currently in dance library data, the side-by-side renders the reference video without a skeleton. Adding the precomputation is a separate PR.
- **Analysis pipeline / move-level metadata.** Saved.
- **Knowledge graph foundation.** Saved.
- **Video alignment / MediaRecorder delay fix.** Still no clear evidence in data.

---

## Working agreement

- Pause after each file group, post a diff summary.
- Flag any conflict with existing code before silently restructuring.
- The side-by-side holding screen is the biggest visual change — verify on mobile 390px before committing.
- If reference pose tracks don't exist in the dance data, do NOT block on building that pipeline. Render video-only on the reference side and flag it.

---

## Acceptance summary (all must pass before PR is ready)

- [ ] `computeDeterministicScore` unit tests pass for all six test cases listed.
- [ ] Sincere attempt produces `displayScore` in the 78-92 range (was 55).
- [ ] Energetic-sloppy attempt produces `displayScore` similar to sincere (energy bias still eliminated).
- [ ] Standing still produces `displayScore` 5-15, `components.legs: 0`.
- [ ] Flailing produces `displayScore` 20-35, `components.legs: 0`.
- [ ] Results card displays the deterministic score, not Gemini's raw `overall_score`.
- [ ] Validation mode debug pill shows both `Gemini raw` and `MediaPipe`.
- [ ] Side-by-side holding screen renders both reference and attempt videos at 390px mobile width.
- [ ] Both videos play in sync (within 100ms drift over 7 seconds).
- [ ] User's pink skeleton renders on right panel.
- [ ] Reference skeleton renders on left panel if data exists, otherwise video-only.
- [ ] Holding screen minimum mount time still ≥3s.
- [ ] Prompt updated with HAND DETAILS ARE MINOR and EXECUTION QUALITY IS MINOR clauses.
- [ ] Callout engine emits `[init]`, `[callout-wired]`, `[frame]` logs at minimum on a real attempt. If not, blocker doc explains why.
- [ ] Results card uses pink for 85+, yellow-green for 75-84, amber for 70-74, red for <40.
- [ ] All existing tests pass.
- [ ] Branch pushed locally, not merged.

---

## After Claude Code finishes — your validation

Run three attempts. For each, paste the on-screen display score AND the raw Gemini JSON.

1. **Sincere accurate attempt.** Display target: 78-92. Should feel like a win. Headline GROOVY or NICE WORK.
2. **Standing still.** Display target: 5-15. Legs should show 0, not 75.
3. **Random flailing.** Display target: 20-35. Legs 0.

Also paste the terminal output from any one attempt showing the `[callout-engine]` logs. If none appear, that's also useful data — we'll have the diagnostic answer.

If sincere lands 78+ and standing/flailing stay <40, the spec succeeded. If sincere is still 60-70, paste the deterministic computation log (`[deterministic] gemini.overall_score=X major=Y moderate=Z minor=W → display=N`) and we tune the formula.
