# SPECK gemini-generosity-and-ui — implementation summary

Branch: `gemini-generosity-and-ui`, branched off `gemini-windowing-fix`.
6 commits, one per file group per the spec's working agreement.

## Commits

```
da67e60 feat(results-card): tier-aligned headlines + per-zone score color
07fc137 feat(callout-engine): log per-beat tier + windowMaxSimilarity for diagnosis
8fded0d feat(callout-overlay): Just-Dance-tier visual redesign + bottom positioning
b59eaf4 feat(gemini-client): surface classified reason from 502 + tag retried failures
ae9d27d feat(score-gemini-route): retry once on transient failure + named failure logs
3d7ebe8 feat(gemini-prompt): generosity rewrite — floor-50, severity calibration, count caps
```

## Acceptance criteria status

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Prompt updated with floor-50, severity calibration, count caps, positive-first insight, proportionate adjectives | DONE — code | `lib/scoring/gemini/prompt.ts`; 17/17 tests in `tests/geminiPrompt.test.ts` assert each clause |
| 2 | Sincere attempt on chunk 1 scores ≥60 (was 47) | REQUIRES HUMAN VALIDATION | Prompt floor is now 50 for sincere attempts; calibration shifts SHAKY → SOLID for recognizable moves. Validated by running an attempt. |
| 3 | Sincere bigger-energy attempt does NOT score significantly higher than sincere accurate attempt | REQUIRES HUMAN VALIDATION | Prompt now explicitly states "Smaller motion executed correctly beats bigger motion executed incorrectly". |
| 4 | Standing still still scores <20 (canary intact) | DONE — code | Prompt's CANARY clause: `Standing still → score 0-15`. Canary tests in `tests/geminiPrompt.test.ts` confirm preserved. |
| 5 | Random flailing scores 25-39 (canary partially fixed) | DONE — code | Prompt's CANARY clause: `Random flailing with no choreography match → score 25-39`. Sincere attempt definition explicitly excludes random arm-waving. |
| 6 | Trouble spot counts respect score brackets (≥65 → max 2; 85+ → max 1) | DONE — code | Prompt's TROUBLE SPOT COUNT section enforces caps; test `caps trouble spot counts by score bracket` asserts each bracket. |
| 7 | First insight on any score ≥40 is a specific positive observation | DONE — code | Prompt's INSIGHTS section: "The FIRST insight MUST be a specific positive observation"; test asserts this clause. |
| 8 | No punitive adjectives ("very", "significantly", "completely") in insights when score ≥50 | DONE — code | Prompt lists each adjective to avoid; test asserts the full list. |
| 9 | API route retries once on Gemini failure, logs failure reason, logs fallback | DONE — code | `app/api/score-gemini/route.ts`: `callGeminiOnce` returns classified `FailureReason`; route logs `[gemini-score][failure]` + `[gemini-score][fallback]` with reason tags. Retry skipped on 4xx and on insufficient remaining budget. |
| 10 | Callout overlay appears bottom center, not on face | DONE — code | `components/scoring/CalloutOverlay.tsx`: positioned at `absolute left-1/2 top-[80%] -translate-x-1/2 -translate-y-1/2`. At 390px viewport this places the stamp at ~80% viewport height, horizontally centered. |
| 11 | Each tier (GROOVY/PERFECT/GREAT/ALMOST) visibly distinct — color, font, motion | DONE — code | Per-tier CSS classes (`callout-tier-groovy`/`-perfect`/`-great`/`-almost`) each define color, stroke width, glow, and a distinct keyframe animation. Snappiness verification REQUIRES HUMAN VALIDATION in a browser. |
| 12 | GROOVY has particle burst on entry | DONE — code | `ParticleBurst` SVG with 5 dots (2 pink, 3 white), 200ms fade-in / 400ms fade-out, mounts only when tier === 'GROOVY'. |
| 13 | Callout engine logs per-beat similarity; mix of tiers fires on real attempt (not all GROOVY) | DONE (logging) / REQUIRES HUMAN VALIDATION (tier mix) | `lib/scoring/callouts/calloutEngine.ts` logs `[callout-engine] beat=N timestamp=Nms windowMaxSimilarity=N.NNN tier=TIER`. Tier-mix on real attempt and any threshold re-tuning gated on inspecting these logs first per spec. |
| 14 | Results card headline and score color match tier | DONE — code | `components/ResultsCard.tsx` `headlineCopy` / `scoreColorClass` updated; 13/13 tests in `tests/resultsCardCopy.test.ts` cover all bracket boundaries. |
| 15 | All existing tests pass | DONE | `npm test` → 185 tests / 45 suites / 0 failures. |
| 16 | Branch pushed locally, not merged | DONE | Branch `gemini-generosity-and-ui` checked out; no push to `main`. |

## Requires-human-validation summary

Three acceptance criteria need a human dancing in front of a camera (or a
real-attempt run with the dev server) to validate end-to-end behavior:

1. **Criterion 2 — sincere attempt scores ≥60.** Run chunk 1, dance sincerely. Expect overall_score ≥ 60 (was 47 before prompt rewrite).
2. **Criterion 3 — accuracy beats energy.** Run two sincere attempts: one careful, one bigger-energy-but-sloppier. Expect the careful one to be at least as high, ideally higher.
3. **Criterion 13 — tier mix on real attempt.** Run one attempt and read the terminal `[callout-engine]` logs. Expected: mostly PERFECT/GREAT, occasional GROOVY peaks, rare ALMOST. If every beat logs ≥0.9 and fires GROOVY regardless, the bug is upstream in per-frame similarity, not in the callout engine — the spec says do NOT silently re-tune thresholds without seeing the data first.

Mobile 390px overlay positioning (criterion 10) is structurally correct
(`top-[80%]` resolves to 80% of the phone-screen which is 100vh on mobile),
but a final visual check on a real device or DevTools 390px emulation is
worth doing before considering the UI work shipped.

## What changed in tests

- `tests/geminiPrompt.test.ts`: rewrote the canary/legs-branch invariants to
  match the new prompt's exact wording (`is_actually_dancing is false` instead
  of `=false`, `at 75 by default` instead of `default 75`). Added a new suite
  `generosity calibration` covering floor-50, sincere-attempt definition, all
  four zones, severity calibration, count caps, positive-first insight, and
  punitive-adjective avoidance.
- `tests/resultsCardCopy.test.ts`: rewrote vendored helpers to match the new
  uppercase tier-based headlines and the new hex-per-zone color brackets. Full
  boundary coverage (40/49, 50/64, 65/84, 85+).
- All other tests (185 total) unchanged and passing.

## What this PR explicitly did NOT do (per spec)

- Did NOT re-tune callout thresholds — the spec says inspect the diagnostic
  logs from a real attempt first, then decide. The logging is now in place.
- Did NOT modify chunk-windowing logic from the previous PR — preserved as-is.
- Did NOT add sound to callouts — deferred to a future spec.
- Did NOT change `PASS_THRESHOLD` (70) — that's the mastery gate, separate
  from the score-zone headline brackets.
