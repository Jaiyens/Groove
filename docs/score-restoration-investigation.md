# Score restoration — investigation

Decision date: 2026-05-23
Branch: `score-restoration`
Spec: `SPECK.md` (top of repo)

## 1. Commits that touched the Gemini prompt

`git log --oneline -- lib/scoring/gemini/prompt.ts` (most recent first):

| # | SHA | Date | Subject |
|---|-----|------|---------|
| 8 | `e63eaa0` | 2026-05-23 | feat(composite): side-by-side video composition + new prompt branch |
| 7 | `c9032ca` | 2026-05-23 | feat(gemini-canary): binary+quantitative canary, component floor 35, tier-capped trouble spots, conditional positive insights |
| 6 | `5291be6` | 2026-05-23 | feat(gemini-onset-trim): cut pre-roll on both videos before scoring |
| 5 | `ff78c62` | 2026-05-23 | feat(gemini-mirror): flip reference horizontally during client trim |
| 4 | `c95a2c9` | 2026-05-23 | feat(gemini-prompt): downweight hand details + execution-quality nits |
| 3 | `3d7ebe8` | 2026-05-23 | feat(gemini-prompt): generosity rewrite — floor-50, severity calibration, count caps |
| 2 | `847eded` | 2026-05-22 | feat(gemini-prompt): chunk-aware prompt with leg-visibility branch |
| 1 | `9394eb2` | 2026-05-22 | feat(gemini): scoring schema + prompt |

Note: the prompt file is `lib/scoring/gemini/prompt.ts`, not `client.ts` (the spec's
example command shape was approximate). Full text of each version is in
`docs/score-prompt-history/<sha>.txt`. Below the per-commit summary then a
heuristics scorecard.

### Per-commit prompt summary

- **v1 `9394eb2`** — Initial constant `GEMINI_SCORING_PROMPT`. Tier bands GROOVY 85-100, SOLID 65-84, SHAKY 40-64, NOT_DANCING 0-39. `is_actually_dancing` canary present (binary only, no forced score consequence). No motion-onset, no side-by-side, no leg-visibility branch, no severity calibration.
- **v2 `847eded`** — Refactored constant → `buildGeminiPrompt(args)`. Adds CHUNK CONTEXT (ignore-padding clause), upper-body-only leg branch (defaulted legs to 75), "IGNORE THOSE TOO" for attempt lead-in/lead-out. Still no motion-onset by value, no side-by-side.
- **v3 `3d7ebe8`** — Generosity rewrite. **HARD FLOOR of 50 for sincere attempts.** Three explicit zones (0-39 / 40-49 / 50-100 with SHAKY/SOLID/GROOVY sub-brackets). Severity calibration. Trouble-spot count caps proportional to score. First insight MUST be specific positive. Lists punitive adjectives to avoid. "Smaller motion executed correctly beats bigger motion executed incorrectly." This is the most coaching-toned version.
- **v4 `c95a2c9`** — Surgical additions: HAND/FINGER DETAILS = MINOR, EXECUTION QUALITY = MINOR. Same scoring zones as v3.
- **v5 `ff78c62`** — Mirror flip at trim time. `referenceMirrored: true` payload toggles a clause: "Grade left and right LITERALLY" vs the legacy mirror-copy clause. Otherwise unchanged from v4.
- **v6 `5291be6`** — Motion-onset trim. New framing clause: "Both videos start exactly at the moment of first dance movement. There is no pre-roll padding." Replaces the "IGNORE THE PADDING" language on the trimmed path. Motion onset is referenced as a CONDITION, not by absolute seconds value.
- **v7 `c9032ca`** — **Canary hardening.** STEP 1 names three trip conditions (postural sway / uncorrelated flailing / ≥30% out of frame) and FORCES `overall_score` into 5-25 when any holds. STEP 2 sets per-component floor of 35 (not 50). Trouble-spot caps re-stated by tier. Conditional-positive-insight (only when `is_actually_dancing: true`). **The old "RAISE THE FLOOR to 50" section was deleted.** legs schema went nullable.
- **v8 `e63eaa0`** — Adds `buildCompositePrompt` for side-by-side composite variant. First commit to use the words "LEFT half" / "RIGHT half." Preserves all v7 invariants (canary, 35-floor, tier-capped spots, conditional positive). Two-halves framing is one paragraph.

### Heuristics scorecard (spec investigation §3)

| Heuristic | v1 | v2 | v3 | v4 | v5 | v6 | v7 | v8 |
|---|---|---|---|---|---|---|---|---|
| Tier thresholds generous | — | — | **✓ floor 50** | ✓ | ✓ | ✓ | — floor 35 components | — same |
| Side-by-side framing | — | — | — | — | — | — | — | ✓ (one paragraph) |
| Qualitative feedback | ✓ insights[] | ✓ | ✓ specific-positive-first | ✓ | ✓ | ✓ | ✓ conditional | ✓ conditional |
| Motion onset by value | — | — | — | — | — | partial (flag only) | partial | partial |
| Coaching tone | — | — | **✓ strong** | ✓ | ✓ | ✓ | weakened | weakened |

## 2. Best historical match (for context)

The user's "81 felt right" memory most likely points at **v3 `3d7ebe8`** —
- floor 50 → a 7-component mean of (50,50,50,50) hits 50, and the SOLID band there is 65-84 (an 81 sits cleanly inside it);
- coaching tone, "Lead with what worked";
- specific-positive-first insight;
- trouble-spot counts proportional to score;
- "Smaller motion executed correctly beats bigger motion executed incorrectly."

v7 `c9032ca` was the regression: the 50-floor was removed in favor of a
per-component 35-floor, AND the headline became the mean of components
(`displayedOverall` in `lib/scoring/deterministic.ts`), so a sincere attempt
that scored components (35,35,35,35) renders as a displayed score of 35.
v8 added side-by-side framing but kept v7's stricter floors.

## 3. Diff: picked-good v3 vs current production v8

| Axis | v3 | v8 (current) | Regression? |
|---|---|---|---|
| Sincere-attempt floor | overall_score ≥ 50 | per-component ≥ 35 | **Yes — major.** Pulls displayed scores down ~15 points. |
| Tier bands | SHAKY 50-64 / SOLID 65-84 / GROOVY 85-100 | SHAKY 40-? / SOLID 65-? / GROOVY 85-100 (component-mean now drives display) | **Yes.** Mean-of-components pushes typical sincere displays into SHAKY. |
| Canary | Soft (canary clause but no forced overall) | Hard: forces overall 5-25 + honest components | Partial regression. Honest components needed; the 5-25 forced overall is fine. |
| Side-by-side framing | Absent | One paragraph | Improvement. But not aggressive enough — the spec wants it in the opening sentences. |
| Schema | `{is_actually_dancing, overall_score, tier, components{arms,legs,body,timing}, insights[], trouble_spots[]}` | Same as v3 | Both differ from the new spec schema. |
| Tier names | GROOVY/SOLID/SHAKY/NOT_DANCING | Same | Both differ from the new spec tier names (GROOVY/SOLID/ALMOST/WARMING_UP/JUST_STARTED). |

## 4. Decision: FALLBACK — write from scratch using spec.md

No historical commit matches all five heuristics:
- v3 has the right coaching tone and floor logic but no side-by-side framing and no motion-onset by value.
- v8 has side-by-side framing but lost the floor and weakened coaching tone.
- **No historical commit emits the JSON schema the spec mandates** (`{score, tier, did_well, work_on, visibility_notes}` with tier enum `GROOVY|SOLID|ALMOST|WARMING_UP|JUST_STARTED`).

Because the spec defines a new response schema and a new tier vocabulary
that no past prompt produces, restoring v3 wholesale would still fail the
spec's response schema. The right move is the spec's documented fallback:
write the prompt from scratch using `SPECK.md` as the source of truth,
drawing inspiration from v3's coaching tone where it doesn't conflict
with the spec.

Implementation plan:
1. Replace `buildCompositePrompt` body to follow spec §Implementation phase
   sections (a) through (g) verbatim, in order.
2. Replace `GeminiScoreSchema` + `GeminiResponseJsonSchema` with the new
   five-field shape.
3. Update `buildFinalScoreView` / `computeDeterministicScore` (and the
   `mediapipeFinalToGeminiShape` fallback) to emit the new schema and feed
   the consumer (`ResultsCard`, drill routing) with adapted data.
4. Bump client timeout 40000 → 90000ms.
5. Add `[gemini-prompt]` and `[gemini-response]` console logs in the
   client.
6. Leave the two-video pipeline (`buildGeminiPrompt`) for the
   `full-fallback` trim path — it'll still emit the OLD schema until/unless
   that path is also migrated. Since the trimmed-composite path is the
   normal one, this is acceptable for the user's validation: the validation
   instructions in the spec assume the composite path fires.

Spec §"What NOT to touch" forbids: motion-onset detection logic, composite
generation, MediaPipe fallback path, debug capture infra, UI code.
Implementation will respect these.
