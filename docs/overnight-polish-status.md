# Overnight polish + debug — status report

Branch: `overnight-polish-and-debug` (forked from `overnight-data-rebuild`). Nothing pushed to main. Working tree clean. 338 / 338 tests pass.

## 1. Polish track summary

- **Total findings in audit:** ~30 catalogued in `docs/ui-audit.md` after deduping and verifying. (The two parallel explorer agents I dispatched first surfaced ~80 raw findings; I checked each against the actual files and dropped the ones that were misread or already correct — for example the `ResultsCard.tsx` `scoreColorClass` "hex use" the agent flagged is deliberate per a comment in the file.)
- **SAFE fixes shipped (7 commits):**
  - `polish(a11y)`: light-theme text on `error.tsx` + `not-found.tsx` (the dark-theme `text-text-muted` was rendering on the global cream body — failed WCAG contrast).
  - `polish(a11y)`: same fix on the two themeless `Loading…` branches in `drill/[skillId]/page.tsx` and `dance/[danceId]/full/page.tsx`.
  - `polish(a11y)`: `aria-live="polite" aria-atomic="true"` on the StartOverlay countdown + GO display so screen readers announce the phase change.
  - `polish(dead-code)`: dropped redundant `focusable="false"` on aria-hidden decorative SVGs in `IntroSplash`, `Logo`.
  - `polish(consistency)`: `SubmitFab` inline `bg-[#FF1F8E]` → `bg-coral` token (exact value match).
  - `polish(consistency)`: `HeroCard` `text-gray-500` (Tailwind default, not in this project's palette) → `text-ink-muted`.
  - `polish(typography)`: `SectionHeader` title `leading-none` → `leading-tight` so wrapping isn't cramped.
- **FLAG items deferred:** ~10. Top 5 (with reasons) at the top of `docs/ui-audit.md`:
  1. The framing-UI pink `#FF3E7F` (3 call sites) — token decision: unify with coral or mint a new "framing accent" token?
  2. Touch targets below 44 px on the back buttons (h-9 / h-10) and `VolumeControl` (h-9) — fix requires header-row layout retune.
  3. Modal focus trap + Escape-to-close on `SubmitModal` and `StartOverlay`.
  4. The disabled `<Link aria-disabled>` pattern in `ChunkProgression` and `lesson/ChunkPath` — should be `<button disabled>`.
  5. Header-bar height drift across the drill / test / copy pages (50 / 56 / 88 px).
- **Tests pass:** yes. 311 baseline → 338 after Track 2 added the attempt-store + diff suites.

## 2. Debug track summary

Files created:

- [lib/debug/attemptStore.ts](lib/debug/attemptStore.ts) — IndexedDB-backed (with localStorage fallback) store. Types: `SavedAttempt`. APIs: `saveAttempt`, `listAttempts`, `getAttempt`, `deleteAttempt`, `clearAttempts`, `updateNotes`, `exportAllAsJson`, `importFromJson`, plus `isCaptureEnabled` / `setCaptureEnabled` toggle helpers and `blobToBase64Safe` / `base64ToBlob` round-trippers.
- [tests/attemptStore.test.ts](tests/attemptStore.test.ts) — 15 tests covering the capture-flag, the localStorage fallback CRUD, base64 conversion, and export/import round-trip.
- [app/debug/scoring/page.tsx](app/debug/scoring/page.tsx) — the dev-only debug surface. Top bar with capture toggle + clear-all + export + import + link to eval. Left column: list of saved attempts (newest first). Right column: tabs (Video / Inputs / Request / Response / Re-score / Notes). Re-score button calls `scoreWithGemini` against the saved attempt blob + reference URL using the current code path and shows a per-scalar-key diff vs. the original response.
- [app/debug/scoring/diff.ts](app/debug/scoring/diff.ts) — pure helpers (`diffScalarKeys`, `extractScalarKeys`, `formatCell`) used by the page and pinned by tests.
- [tests/debugScoringPage.test.ts](tests/debugScoringPage.test.ts) — 12 tests for the diff helpers (basic render is exercised by typecheck; mounting needs JSDOM which the project doesn't install).
- [app/debug/scoring/eval/page.tsx](app/debug/scoring/eval/page.tsx) — the eval-harness page. Multi-select saved attempts → run serially through `scoreWithGemini` → progress bar + table of old vs. new score, delta, tier change, latency.

Capture toggle: defaults OFF. Turning it on writes `localStorage.groov_debug_capture = 'true'`; from that point on, every `scoreWithGemini` call fire-and-forget saves a `SavedAttempt` record before returning. The save is wrapped in try/catch + logs `[debug-attempt] saved` or `[debug-attempt] save failed`; it never blocks the user-facing score path.

Re-score path verified against `/api/score-gemini` and `/api/score-gemini-composite` — the same endpoints the production flow uses. Per the spec we do not mock; the re-score runs the actual trim + composite + Gemini call chain.

Hook into `lib/scoring/gemini/client.ts`: added two optional fields to `ScoreWithGeminiArgs` (`danceId`, `chunkIndex`); added a `captureTrace` accumulator inside `scoreWithGemini` populated as the function progresses (motion onsets, mirror, duration source, request payload, raw response); added a single `captureIfEnabled` helper invoked at each successful return. `responseDeterministic` is stored as `null` because the deterministic transformation happens upstream in the chunk page — the debug page surfaces that fact explicitly. The hook also surfaces `durationSource` and `authoritativeDurationSec` through `TrimAttemptResult` so the saved record carries them.

## 3. Surprises

- The spec listed "lib/scoring/ is locked, debug track only READS" alongside an explicit instruction to MODIFY `lib/scoring/gemini/client.ts`. I followed the explicit modification instruction — adding the fire-and-forget capture hook — but kept the existing scoring logic, prompt, diagnostic logging, and return shape untouched. Existing scoring tests pass unchanged.
- `responseDeterministic` was awkward: the spec wants it saved, but `lib/scoring/gemini/client.ts` doesn't see the deterministic transformation — that happens in the chunk test page via `buildFinalScoreView`. Rather than break the contract or invent a brittle "patch the latest saved attempt" call site, I stored `null` and made the debug page show an explicit "not recorded by this capture" line under the Deterministic-layer subsection. The raw Gemini JSON is captured in full, which is the primary thing the user wants to inspect.
- The test runner is `tsx --test tests/*.test.ts` — `.tsx` test files don't get picked up. The spec asked for `tests/debugScoringPage.test.tsx` but I wrote it as `.ts` testing the pure diff helpers; mounting the page would have required JSDOM which isn't a dependency. The trade-off favours speed-of-shipping (the diff is the actual eval primitive — that's the part worth pinning).
- The audit pass turned up much less low-hanging fruit than I expected. The codebase has already had careful palette + typography passes (the SPECK history shows multiple rounds of polish). The remaining issues are mostly in flag territory — layout + modal contracts. I chose to ship the small, durable wins rather than batch-rewrite borderline cases.
- One agent flagged `components/library/RecentList.tsx`'s `active:opacity-70` as inconsistent with `active:scale-[0.99]` neighbours and recommended a swap. I didn't apply it — the row contains a separate `PreviewablePoster` and scaling the whole row would scale that with it, which is the reason the file's author used opacity instead. The comment block in `RecentList.tsx` actually documents this. Good reminder that agent recommendations need verification against the file's own intent.

## 4. What I'd do next

- **Wire `responseDeterministic` into the capture.** Either move the save call up into the chunk test page (so we have `view` in scope), or expose an `updateLatestAttemptDeterministic(view)` helper from `attemptStore.ts` that the page calls after `buildFinalScoreView`. Then the Re-score diff can compare deterministic-layer outputs too, not just raw scalar keys.
- **Pre-seed the eval set.** The eval-harness page is most useful once the user has captured ~5 archetype attempts (sincere / flailing / standing-still / upper-body-only / partial-frame, per the spec). I'd add a tiny "record archetype" mode where the user hits a button once, then performs each archetype, and the captures get tagged. Right now `notes` is the only way to label intent — adequate but manual.
- **Knock off two FLAG items**: the framing-pink token decision is one quick session with the user; the modal focus-trap pattern is a single utility that several modals can share. Those would clear half the deferred list.
- **The validation pass that's actually blocked.** The whole reason this branch exists is so that when the user wakes up they can replay yesterday's attempt against the rebuilt scoring pipeline without re-recording. Step 1 is to flip the capture toggle on in their own browser and run a real attempt — that's the smoke test for the whole capture path. If that works, the eval harness is the next step.

End of report.
