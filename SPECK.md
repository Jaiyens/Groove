# SPECK — overnight UI/UX audit + scoring debug surface

## Read this first

You are working overnight. The user is asleep. **Aggressive mode: keep going, try alternatives, ship what works.** Do not stop and ask. If something fails on one file, move to the next. Only stop when (a) you have shipped everything in this spec, or (b) you hit something that genuinely cannot be solved without the user.

Branch off `overnight-data-rebuild`. New branch: `overnight-polish-and-debug`. **One commit per fix, tagged by category.** Do not push to main.

When you finish each track, paste a diff summary to the terminal so the user can read the trail when they wake up. End the run with a status report at `/docs/overnight-polish-status.md`.

---

## The big picture — why this exists

The scoring pipeline got five rounds of focused work and now needs a real-device validation pass in the morning before we know what to do next. That validation is blocked until the user wakes up. Meanwhile, the rest of the app has been getting incremental fixes without anyone doing a systematic pass. There's almost certainly low-hanging fruit: inconsistent button styles, missing loading states, accessibility issues, places where components were written twice instead of reused, dead code paths, mobile bugs.

Tonight's mission is two tracks:

1. **Polish track:** systematic UI/UX audit of every page and component. Document everything. Auto-fix the safe categories. Flag the unsafe ones for human review.
2. **Debug track:** build a `/debug/scoring` page that lets the user replay attempts in the morning and inspect exactly what Gemini saw — without having to re-record. This is the validation tool that will accelerate every future scoring iteration.

The polish track is bigger. The debug track is the higher-leverage smaller piece. Do polish first because it has more independent fixes (more chances to ship something useful even if other parts fail). Do debug second.

---

## Hard rules

1. **One commit per fix.** Each commit message starts with a category tag: `polish(a11y):`, `polish(typography):`, `polish(spacing):`, `polish(mobile):`, `polish(dead-code):`, `polish(consistency):`, or `feat(debug-scoring):`. The user must be able to revert any single fix without losing others.
2. **No layout changes.** No restructuring page hierarchy. No moving components between files. No changing component APIs. If a fix would require those, flag it in the audit doc instead of doing it.
3. **No new dependencies.** Use what's installed. If a fix would need a new package, flag it.
4. **All existing tests must pass after every commit.** Run `npm test` after each fix. If a fix breaks tests and you can't make them pass within ~3 attempts, revert that fix and document.
5. **All diagnostic logging from rounds 1–5 stays.** Do not touch `[gemini-client]`, `[gemini-score]`, `[deterministic]`, `[callout-engine]` lines.
6. **The scoring pipeline is locked.** Do not modify `lib/scoring/`, `app/api/score-gemini*`, `app/api/repair-webm`, or anything under `lib/scoring/gemini/`. The polish track does not touch these. The debug track only READS from them.
7. **Mobile-first.** Verify Tailwind classes work at 390px. Touch targets ≥ 44px. No horizontal scroll.
8. **The mirror unification from Group 2 of the prior run is canonical.** Anywhere a component references mirror state, it reads from `lib/preferences/mirror.ts`. Do not introduce new mirror logic.

---

## Track 1 — UI/UX audit + polish (the big track)

### Phase 1.A — Audit pass (READ ONLY, write findings to disk)

Before touching any code, walk every file under `app/` and `components/`. For each file, look for issues in these categories. Write findings to `/docs/ui-audit.md` as you go. Categorize every finding.

**Categories to look for:**

**A11Y (accessibility):**
- Missing `alt` text on images
- Buttons with no accessible label (icon-only buttons without `aria-label`)
- Form inputs without labels or `aria-label`
- Color used as the only way to convey information
- Focus states that are removed (`outline: none` without replacement)
- Heading hierarchy broken (h1 → h3 with no h2)
- Click handlers on non-button elements without `role="button"` and keyboard handlers
- Modals/overlays without focus trap or escape-to-close
- Live regions missing for dynamic content (toasts, score updates)
- Color contrast issues — anything where text color and background color look close. Check `text-gray-400` on `bg-white`, `text-white` on light backgrounds, etc.

**TYPOGRAPHY:**
- Inconsistent font sizes for similar UI roles (one button uses `text-sm`, another uses `text-base`, both are "primary action buttons")
- Inconsistent font weights for similar roles
- Missing line-height on long text blocks
- Letter-spacing inconsistencies
- Mixed font families where one is intended
- Display fonts (Bungee, etc) used in body text or vice versa

**SPACING:**
- Inconsistent padding/margin for similar containers (one card uses `p-4`, another uses `p-6`)
- Magic numbers in spacing (`mt-[13px]` instead of Tailwind's scale)
- Stacked elements without consistent gap (some use `space-y-4`, some use `mb-4` on each child)
- Containers that touch viewport edges on mobile (no horizontal padding)

**MOBILE:**
- Touch targets smaller than 44px (interactive elements with small heights/widths)
- Text that overflows on narrow viewports
- Modals or fixed elements that overflow the viewport
- Buttons positioned where thumbs can't reach (top of screen on long pages)
- Forms where the keyboard would cover the input
- Hover-only interactions with no tap equivalent

**DEAD CODE:**
- Imports that aren't used (after type-only refactors)
- Components defined but never imported
- Props passed but never used
- State variables that are set but never read
- Effects with no observable purpose
- Commented-out code older than a few days

**CONSISTENCY:**
- Two components doing the same thing in different ways (two button styles, two card styles)
- Colors used inline as hex when a Tailwind token exists
- Tailwind arbitrary values where a token would work (`bg-[#FF1F8E]` instead of a named color)
- One page using `<Link>` for navigation, another using `router.push()` for the same kind of nav
- Inconsistent loading states (one page shows spinner, another shows skeleton, another shows nothing)
- Inconsistent empty states
- Inconsistent error states

**INTERACTION:**
- Buttons without visible disabled states
- Forms that submit on Enter but don't show that affordance
- Click areas smaller than the visible element (or vice versa)
- Long actions without progress feedback
- Destructive actions without confirmation

For each finding, write:
```
### [CATEGORY] [file:line]
What: <one-line description>
Why it matters: <one-line user impact>
Fix: <proposed fix, or "FLAG — needs human review">
Safety: SAFE | FLAG
```

`SAFE` means: the fix changes appearance/behavior in a small, isolated, easily-revertible way and you're confident the result is better. `FLAG` means: the fix would change layout, change a component's contract, or has a judgment call you can't make alone.

Save the audit as `/docs/ui-audit.md`. Commit with message: `docs(ui-audit): catalog of UI/UX findings before polish pass`.

### Phase 1.B — Auto-fix the SAFE findings

Work through `/docs/ui-audit.md`. For every finding tagged `SAFE`:

1. Make the fix.
2. Run `npm test`. If it fails and you can't fix within 3 attempts, revert and re-tag the finding `FLAG` in the audit doc.
3. Commit with appropriate category tag.

**Order matters.** Do a11y first (highest leverage, lowest risk), then dead-code (clears noise), then consistency (sets a baseline), then typography + spacing, then mobile, then interaction. This order means each later category benefits from earlier cleanup.

**Commit granularity:** group fixes by file when they're the same category. One commit can cover "polish(a11y): add aria-labels to icon buttons in components/library/*" if it's a single mechanical change across files. Do NOT combine categories into one commit.

**Things to watch out for:**

- **Tailwind tokens:** if the project has a custom color palette in `tailwind.config.ts`, prefer the tokens. If you find hex values that match existing tokens, swap them. If they don't match, leave them and flag.
- **Headers and titles:** if multiple pages set their own `<h1>`, they should look consistent. Don't centralize them — just make sure they use the same classes.
- **Buttons:** if there's a `Button` component, audit whether all interactive elements use it. If not, flag — but don't bulk-replace.
- **`<Link>` vs `router.push`:** if a button-styled `<a>` does navigation, prefer `<Link>`. Inverse — don't convert programmatic navigation just for consistency.
- **Loading/empty/error states:** if a page is missing one, add the simplest version (a centered "Loading..." or "Nothing here yet"). Match the visual style of other states in the app. Flag if there's no existing pattern.

### Phase 1.C — Flag report

After auto-fixes are done, re-read `/docs/ui-audit.md`. Anything still tagged `FLAG` stays in the doc with full context. Add a final section at the top of the audit doc: `## Flagged for human review`, listing each flagged item with a one-line reason it was deferred.

Commit: `docs(ui-audit): final report with flagged items for human review`.

---

## Track 2 — Scoring debug surface

This is the higher-leverage smaller track. Build a `/debug/scoring` page that lets the user replay past attempts and inspect exactly what Gemini saw, without re-recording.

### Why

Every scoring iteration so far has required the user to dance in front of a camera, then paste console logs back. That's a 5–10 minute loop per attempt. With this debug surface, the user can record once, save the artifacts, and replay-validate any code change against the same artifacts.

It's also the foundation for systematic prompt tuning: you can load 5 saved attempts (sincere, flailing, standing still, upper-body-only, partial-frame) and run them through the current code path to see how it scores each one. That's the eval harness Gemini-grading needs to mature.

### Phase 2.A — Capture infrastructure

When a real attempt happens, save the artifacts to localStorage (or IndexedDB if size demands) under a key like `groov_debug_attempt_<timestamp>`. Artifacts to save:

- The raw attempt blob (base64 or as a Blob URL — investigate which works better with the size constraints)
- The reference video URL
- The chunk start/end timestamps
- The motion-onset values (ref + attempt)
- The mirror state
- The legs visible flag
- The full request body sent to `/api/score-gemini` (or `/api/score-gemini-composite`)
- The full response from the API including `latencyMs`, `[gemini-score]` block, raw Gemini response, deterministic-layer output

### NEW: `lib/debug/attemptStore.ts`

```typescript
export type SavedAttempt = {
  id: string;            // timestamp-based
  savedAt: number;
  danceId: string;
  chunkIndex: number;
  referenceUrl: string;
  attemptBlobBase64: string;    // see size note below
  attemptMimeType: string;
  chunkStartMs: number;
  chunkEndMs: number;
  motionOnsetRefSec: number | null;
  motionOnsetAttemptSec: number | null;
  mirror: boolean;
  legsVisible: boolean;
  requestPayload: unknown;       // the body of the POST to /api/score-gemini[-composite]
  responseRaw: unknown;          // the Gemini JSON before deterministic-layer transformation
  responseDeterministic: unknown; // what ResultsCard rendered
  latencyMs: number;
  durationSource: 'webm-repair-inferred' | 'browser-finalize' | 'server-repair' | null;
  authoritativeDurationSec: number;
  notes?: string;                // user-editable, written by the debug page
};

export async function saveAttempt(attempt: Omit<SavedAttempt, 'id' | 'savedAt'>): Promise<string>;
export async function listAttempts(): Promise<SavedAttempt[]>;
export async function getAttempt(id: string): Promise<SavedAttempt | null>;
export async function deleteAttempt(id: string): Promise<void>;
export async function updateNotes(id: string, notes: string): Promise<void>;
```

**Storage decision:** localStorage caps at ~5–10MB per origin. A 7s webm at 1.5MB base64-encodes to ~2MB. So localStorage holds ~3 attempts max before throwing. Use **IndexedDB** via a tiny wrapper. Don't pull in a library — write a 50-line wrapper using the native API. Schema: one object store `attempts`, keyPath `id`.

If IndexedDB write fails (private browsing, disk quota), fall back to localStorage and warn in console. If both fail, return an error string from `saveAttempt`.

### MODIFIED: `lib/scoring/gemini/client.ts`

After `scoreWithGemini` returns (whether success or fallback), call `saveAttempt(...)` with all the inputs and outputs collected during the call. **Do not block the user-facing scoring on this save** — fire and forget, wrapped in a try/catch that logs but doesn't throw. Tag the log line `[debug-attempt] saved` or `[debug-attempt] save failed`.

Add a toggle: only save when `localStorage.getItem('groov_debug_capture') === 'true'`. Default OFF. The debug page provides a toggle UI to enable.

### Phase 2.B — The debug page

### NEW: `app/debug/scoring/page.tsx`

A simple client-rendered page. No auth (this is a dev tool). Layout:

**Top bar:**
- Title: "Scoring Debug"
- Toggle: "Capture attempts" (writes to `localStorage.groov_debug_capture`)
- Button: "Clear all" (with confirm)
- Button: "Export all" (downloads a JSON file of all saved attempts, blobs as base64)
- Button: "Import" (file picker, accepts the JSON from Export)

**Left column — Attempts list:**
- List of saved attempts, newest first.
- Each row shows: timestamp, dance ID + chunk index, displayed score, tier badge, latency, durationSource tag.
- Click to select. Selected row highlighted.

**Right column — Detail panel for selected attempt:**

Five tabs:

1. **Video** — render the attempt blob as a `<video controls>`. Below it, a "Reference" video that loads the referenceUrl and seeks to chunkStartMs. Two players, side by side on desktop, stacked on mobile.

2. **Inputs** — pretty-printed JSON of: chunk timestamps, motion-onset values, mirror, legsVisible, durationSource, authoritativeDurationSec.

3. **Request** — pretty-printed JSON of the request payload that went to the API (with the video base64 truncated to `<base64: X.X MB>` placeholders so the panel is readable).

4. **Response** — three sub-sections:
   - **Raw Gemini JSON** — the `responseRaw` object, pretty-printed.
   - **Deterministic layer** — the `responseDeterministic` object showing displayedOverall, components, tier, trouble spots after the formula.
   - **Latency** — `latencyMs`.

5. **Notes** — a textarea bound to `updateNotes()`. User can write observations ("this attempt was sincere but Gemini scored it 10 — duration was wrong"). Autosaves on blur.

**Re-run button (top of detail panel):**
- "Re-score with current code" — sends the saved request payload to the API again, displays the new response in a fourth tab "Re-score result" with a diff against the original response. This is the eval-harness primitive: change the prompt, re-score every saved attempt, see what moved.

### Implementation notes

- This is a single page. Don't over-architect. Inline most components.
- Use only existing dependencies. If you need a JSON viewer, render with `<pre>{JSON.stringify(obj, null, 2)}</pre>`. If you need a diff, do a simple key-by-key comparison and highlight changed keys.
- The "Re-score" button calls the same API endpoints the production flow uses. The point is to test the actual code path, not to mock anything.
- The video players should support seek and looping. Use the native `<video controls>` for simplicity.
- Mobile: the page is dev-only, optimize for desktop. But don't break on mobile — if width < 768px, stack the panels.

### Phase 2.C — Eval harness primitive

### NEW: `app/debug/scoring/eval/page.tsx`

A second debug page: select multiple saved attempts (checkboxes), click "Re-score all," watch a progress bar, get a table of results showing per-attempt: old score, new score, delta, tier change.

This is the foundation for systematic scoring iteration. The user runs 5–10 sincere attempts once, saves them, then for every prompt change can re-score the whole set in 60 seconds and see what moved.

Same constraint: simple, inline, no new deps. The progress bar can be `<progress max={total} value={completed} />`.

### Acceptance for Track 2

- Capture toggle defaults to OFF. Turning it on causes the next attempt to be saved.
- `/debug/scoring` page renders without errors. Lists saved attempts. Clicking one shows the detail tabs.
- Re-score works against the live API.
- Eval page processes multiple attempts and produces a results table.
- All existing tests still pass.
- Two new test files: `tests/attemptStore.test.ts` (the IndexedDB wrapper) and `tests/debugScoringPage.test.tsx` (basic render test — list + detail toggle).

Commit messages: `feat(debug-scoring): attempt capture store`, `feat(debug-scoring): debug page with re-score`, `feat(debug-scoring): eval harness page`.

---

## End-of-run report

Write `/docs/overnight-polish-status.md`:

1. **Polish track summary:**
   - Total findings in audit: X
   - SAFE fixes shipped: X (broken down by category)
   - FLAG items deferred: X (top 5 highlighted with reasons)
   - Tests pass: yes/no
2. **Debug track summary:**
   - Files created
   - Capture toggle status
   - Re-score path verified against which endpoint
3. **Surprises:** anything different from this spec.
4. **What I'd do next:** honest opinion.

Commit: `docs(overnight): polish + debug status report`.

---

## Working agreement

You are working aggressively. That means:

- If a SAFE fix turns out to break something subtle when you run tests, revert it, re-tag FLAG, and move on. Don't get stuck on one fix.
- If the audit pass surfaces 200+ findings, that's fine — but don't try to fix all 200 tonight. Fix the highest-leverage ones (a11y, dead code, consistency) and document the rest. Quality over volume.
- If the debug page hits a structural problem (e.g., IndexedDB won't write base64 strings over a certain size), try a different approach (Blob URLs, chunked storage, smaller capture window). Document what you tried.
- If you finish both tracks with time to spare:
  1. Add JSDoc comments to `lib/scoring/gemini/` exported functions (READ-ONLY otherwise — don't change scoring logic).
  2. Write `/docs/known-issues.md` rolling up everything currently fragile in the app.
  3. Audit the `tailwind.config.ts` for unused color tokens, duplicated values, opportunities for new tokens that would reduce arbitrary values you found in the polish audit.

The user values intellectual honesty. If a fix didn't work and you can't make it work, say so plainly in the status report. Don't invent reasons it's actually fine.

Branch state when you stop: commits on `overnight-polish-and-debug`, working tree clean, all tests passing, nothing pushed to main.

Good luck.