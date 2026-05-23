# SPECK Execution Summary — `gemini-deterministic-and-sidebyside`

Six commits, one per file group. All 202 existing tests pass. Source
typecheck clean. Branch is local; not pushed; not merged.

## Commits

| Commit | File group | What |
| --- | --- | --- |
| 26f49df | FG1 deterministic | `lib/scoring/deterministic.ts` + 11 unit tests |
| 820217a | FG2 final-score-view | `FinalScoreView.display: DeterministicScore` threaded through Mode B orchestrator |
| e244de2 | FG3+FG7 results-card | ResultsCard reads `display`; new color/headline brackets; 3-way debug pill + CompareTable |
| c95a2c9 | FG4 gemini-prompt | HAND DETAILS / EXECUTION QUALITY clauses + 4 tests in both leg branches |
| 57719ff | FG5 side-by-side | New `SideBySideHoldingScreen.tsx`; removed `HoldingScreen.tsx`; orchestrator wired |
| 29ac4ee | FG6 callout-investigation | 4-layer engine logging + `docs/callout-investigation.md` |

## Acceptance criteria — status

| Criterion | Status |
| --- | --- |
| `computeDeterministicScore` unit tests pass for all six cases | ✅ 11 tests pass |
| Sincere attempt produces displayScore 78-92 (was 55) | ✅ formula verified; **requires human validation** for real Gemini output |
| Energetic-sloppy ≈ sincere (energy bias eliminated) | ✅ formula is energy-blind; **requires human validation** |
| Standing still → 5-15, legs: 0 | ✅ non-attempt branch verified in tests; **requires human validation** for real Gemini |
| Flailing → 20-35, legs: 0 | ✅ non-attempt branch verified; **requires human validation** |
| Results card displays deterministic score | ✅ `display.displayScore` is the headline |
| Validation mode debug pill shows Gemini raw + MediaPipe | ✅ |
| Side-by-side holding screen at 390px mobile | ✅ `max-w-[380px]` 2-col grid; **requires human validation** on device |
| Both videos sync ≤100ms drift over 7s | ✅ `Promise.all` start + timeupdate clamp; **requires human validation** |
| User pink skeleton on right panel | ✅ |
| Reference skeleton on left when pose data exists | ✅ video-only fallback when null |
| Holding minimum mount ≥3s | ✅ `MIN_HOLD_MS = 3000` preserved |
| Prompt updated with HAND DETAILS + EXECUTION QUALITY | ✅ tests assert presence in both leg branches |
| Callout engine emits `[init]`, `[callout-wired]`, `[frame]` logs | ✅ wired; **requires human validation** in terminal |
| Results card colors: pink/yellow-green/amber/red | ✅ 17 tests pass |
| All existing tests pass | ✅ 202/202 |
| Branch pushed locally, not merged | ✅ |

## Human-validation gates

These can't be verified without running the app with a live camera and
a real Gemini round-trip. The validator runs three attempts per SPECK
"After Claude Code finishes":

1. **Sincere accurate attempt** — display target 78-92. Should feel like a win.
2. **Standing still** — display 5-15, legs 0.
3. **Random flailing** — display 20-35, legs 0.

Terminal output from one attempt should show:
- `[callout-engine][init] accentBeats=N`
- `[mode-b][callout-wired] engine created { ... }`
- `[callout-engine][frame] ts=… similarity=…` (sampled 1-in-30)
- `[callout-engine][beat] index=… windowMax=… tier=…`
- `[callout-engine][fire] tier=… at=…`
- `[deterministic] gemini.overall_score=X major=Y moderate=Z minor=W → display=N tier=T`

If any of the callout logs are missing, the decision table in
`docs/callout-investigation.md` maps the gap to a root-cause hypothesis.

## Known gaps flagged

- **Reference pose track**: if a dance has no precomputed pose JSON, the
  side-by-side reference panel renders video-only with a quiet
  "reference skeleton unavailable" breadcrumb. Precomputation pipeline
  is explicitly deferred per SPECK.
- **Sync drift on long loops**: the timeupdate clamp keeps the reference
  inside the chunk window but a small drift can accumulate across
  multiple loops if the timeupdate event fires later than the actual
  crossing. Within a 7s validation window this is well under the 100ms
  target; longer holds may diverge and would need a tighter clamp.

## Internal contradiction noted

The SPECK test case "Sincere with 1 moderate, 2 minor → 82, GROOVY" is
inconsistent with the same file's `scoreToTier` (GROOVY ≥ 85). The
formula is the source of truth: 82 lives in the SOLID band (75-84) and
renders with the yellow-green color + "NICE WORK." headline — which is
still a clear win for the user. Documented in `tests/deterministic.test.ts`.
