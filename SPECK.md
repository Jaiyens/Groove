# OVERNIGHT_SPEC.md — Groove, two-track run

You are running unattended for ~8 hours. Read this whole file before you start.

You're working on Groove (Next.js, TypeScript, Tailwind, Supabase, deployed to Vercel at `groove-eight.vercel.app`). The user is asleep. There is no one to answer questions. Behave accordingly.

---

## Operating rules (non-negotiable)

1. **Work on a fresh feature branch off `main`.** Name it `overnight/<YYYY-MM-DD>-results-teaching-surface`. Never push to `main`. Never force-push. When you finish, leave the branch local and unpushed — the user reviews before pushing.

2. **One commit per logical task.** Conventional commits (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`). The user must be able to revert any single commit cleanly in the morning. No 300-file mega-commits.

3. **Verification loop is mandatory.** After every code change, before committing:
   - `pnpm typecheck` (or `npx tsc --noEmit` if no script)
   - `pnpm lint`
   - `pnpm test` if a test exists for the touched file or its imports
   - `pnpm build` — must succeed at least once per track before that track is "done"

   If any of these fail, you fix them before moving on. You do **not** commit broken code and call it done. You do **not** use `// @ts-ignore` or `// eslint-disable` to make errors go away — fix the underlying issue. The one exception is genuine third-party type bugs, which must be commented with `// LIBRARY BUG:` and logged in `OVERNIGHT_STATUS.md`.

4. **Write `OVERNIGHT_STATUS.md` continuously.** Update it after every task. Sections:
   - **Shipped** — what landed, with commit SHA and one-line description
   - **Skipped** — tasks you decided not to do and why
   - **Blocked** — anything you couldn't figure out, with the specific question for the user
   - **Surprises** — anywhere you deviated from this spec and why
   - **Untested** — anything that compiled but you couldn't actually verify end-to-end
   - **Morning checklist** — the 3-5 things the user should check first when they wake up

5. **Write `DECISIONS.md` for any ambiguous call.** Format: question, what I chose, why, what the alternative was, how to undo. Use this when the spec is silent — don't freeze, don't ask, decide and log it.

6. **Tiebreaker for ambiguity.** When the spec doesn't tell you what to do, default to: (a) the option that makes the results screen *more pedagogical* (teaches the user something) rather than *more decorative*, (b) the option that's reversible over the one that's a one-way door, (c) the option that ships a working slice over the one that ships a half-built grander version.

7. **Persistence.** Your context will auto-compact as you approach the limit — that's expected, keep working. Do not stop early due to token budget concerns. Before the context window refreshes, save your current progress and state to `OVERNIGHT_STATUS.md` and `DECISIONS.md` so the next context can pick up cleanly. Keep going until either every task in TRACK A is done or you hit a real, logged blocker on every remaining task.

8. **No scope invention.** Everything you do must trace back to a task in this spec. If you find a bug or a tempting refactor not in scope, write it to `FOLLOWUPS.md` and move on. The single biggest failure mode for overnight runs is the 4am refactor spree. Don't.

---

## LOCKED — do not touch

These files/directories are off-limits this run. Touching them is a hard fail.

- `lib/scoring/**` — scoring pipeline
- `lib/pose/**` — pose extraction
- `app/api/scoring/**`, `app/api/score/**`, any scoring API routes
- `app/debug/**` — the eval harness from the last overnight run. Untouchable.
- `lib/mirror*` — mirror state lib
- `worker/**` and anything Supabase server-side ingest related
- `lib/dances/fixtures.ts` and the knowledge graph JSON file itself (you can READ it, never WRITE it)

If you genuinely need to change something locked to ship a task, **stop that task**, log it to `BLOCKERS.md`, move to the next task. Do not work around the lock.

---

## In scope

- The results screen (post-attempt) — full redesign as a teaching surface
- New "drill" route(s) and the loop between results → drill → re-attempt
- Wiring the knowledge graph into the results screen and drill recommendations
- UI polish on library, dance picker, framing screen (parallel safe track)
- Any new shared components needed for the above (cards, score visualizations, skill chips, progress bars)
- `lib/graph/**` — readers, selectors, and recommender logic that *consume* the graph (you can write to this dir; you cannot modify the graph data file itself)

---

# TRACK A — Results screen as a teaching surface (primary)

This is the priority. If you finish nothing else, finish this.

## The problem

Today, after a user dances, they see a score and a per-move breakdown. It's a report card. Daniel and the user both want it to be a **teaching surface** — the user should leave the results screen knowing (a) what skills they're weak at *by name from the knowledge graph*, (b) what specific drill will fix the weakest one, and (c) why this matters for the next dance they'll try. The drill loop has to actually fire — tap weak move → land in a 60–90s drill → finish drill → return to a re-attempt CTA.

## Phase 1 — Design spec first (do this BEFORE any UI code)

Create `docs/results-screen-spec.md`. In it:

1. Read the current results screen end-to-end. List every piece of data it currently has access to (overall score, per-segment scores, motion onsets, mirror state, attempt video URL if any, reference video URL, dance ID, chunk index, etc.). Use grep + actual file reads — don't guess.

2. Read the knowledge graph JSON. List the node shape, edge shape, and what fields exist on a node (id, name, layer, prerequisites, drills, etc.). You're going to reference this constantly.

3. Read the dance fixtures. Understand how a dance maps to skill graph nodes. If the mapping doesn't exist yet, that's a real finding — log it as the first blocker for Phase 2 and propose the mapping shape in the spec.

4. Design the results screen as five stacked sections, top-to-bottom on mobile:
   - **Header** — score, dance title, one-line "what this means" (e.g., "Solid — your isolations landed, footwork drifted")
   - **The skill breakdown** — not "Move 1: 72%" but "Hip isolation: 78% · Travel step on 4: 54% · Arm wave decay: 81%" — *skill names from the graph*, not move indices
   - **The teach card** — the single weakest skill, expanded: what it is, why it matters, what dances unlock when you nail it, one-tap CTA to drill it
   - **Other skills to work on** — 2 more weak skills as smaller cards
   - **Next step** — re-attempt this dance / try a recommended next dance / view library

   Define for each section: what data feeds it, what graph fields it pulls from, what happens on tap, the mobile dimensions, the visual hierarchy, what makes it pedagogical vs decorative. Keep it text + ASCII layout — don't try to design pixel-perfect.

5. Define the drill route. URL shape, what's on the page, how it loops back. A drill is: a short looping reference clip of the weak skill in isolation, the user mimics it, optional re-score on the drill itself, then a CTA back to re-attempt the full dance.

6. Commit this spec as the first commit of the run: `docs(results): design spec for teaching surface`.

## Phase 2 — Graph + recommender layer

In `lib/graph/`:

1. `loader.ts` — typed reader of the graph JSON, with Zod validation. If it exists, extend it; don't replace it.
2. `recommender.ts` — given a results object (overall + per-skill scores) and the graph, return `{ weakestSkill, nextTwoWeak, recommendedDance, drillCandidates }`. Pure function, no UI. Unit tests in `lib/graph/__tests__/recommender.test.ts` covering: all-strong case, all-weak case, mixed case, missing skill mapping (graceful fallback).
3. `dance-skill-map.ts` — if the mapping from dance→skill-nodes doesn't exist yet, create a lightweight one. Start with the 3 reference dances mapping to their primary skill nodes. Make it a typed lookup, not hardcoded JSX.

Commit each file separately. Verify tests pass before committing.

## Phase 3 — Results screen rebuild

Build the five sections from the spec. Components go in `components/results/` (or wherever existing results components live — match the convention). Each section is its own component, composable, mobile-first. Tailwind only — no new dependencies for this.

Order of build:
1. Header
2. Skill breakdown (consumes recommender output)
3. Teach card (the big one — this is the teaching surface)
4. Other weak skills
5. Next step CTA row

After each section: typecheck + lint + commit. After all five: build + manual sanity (run dev server, hit the route, screenshot the page state into `docs/screenshots/results-after.png` if possible via Playwright; if Playwright isn't installed, skip the screenshot and note it in STATUS).

## Phase 4 — Drill route + loop

1. Add the drill route — `app/dance/[danceId]/drill/[skillId]/page.tsx` (or match existing route patterns).
2. The drill page: looping reference clip of the skill, the user records or mimics, a "done" CTA back to re-attempt. If the looping reference doesn't exist as data yet, the drill page uses a placeholder + a clear "drill content coming" state — do not block on missing video assets. Log the missing assets to `FOLLOWUPS.md`.
3. Wire the results screen's "drill this" CTA to the drill route.
4. Wire the drill's "done, try again" CTA to the dance's Mode B re-attempt.

The point isn't perfect drill content tonight — the point is the **loop closes**. Tap weak move → drill route loads → tap done → back to re-attempt. That whole sequence has to work end-to-end before this track is "done."

## Phase 5 — Verify the full loop

Spin up the dev server. Walk the path: library → pick a dance → Mode A → Mode B → score → results (new) → tap weakest → drill → done → re-attempt. Document every break in `OVERNIGHT_STATUS.md` under Untested or Blocked. Don't fake "works" — if a step is broken and you can't fix it cleanly, log it.

---

# TRACK B — Safe UI polish (parallel, lower priority)

Only touch this once TRACK A Phase 3 is complete. Do not interleave TRACK B with TRACK A's results-screen build — context-switching wastes the run.

Scope: library screen, dance picker screen, framing screen. **Not** the results screen (that's TRACK A's territory) and **not** Mode A or Mode B (those are scoring-adjacent — locked).

For each screen, in this order:
1. Read the screen file. Audit for: spacing inconsistencies (mixing `gap-2`, `gap-3`, `gap-4` arbitrarily), color tokens not matching design tokens, ad-hoc font sizes, missing hover/active states on tappable elements, missing accessibility (aria-labels on icon buttons, focus rings), broken responsive at <380px width.
2. Write findings to `docs/polish-audit.md` as a list with severity (HIGH/MED/LOW).
3. Apply only HIGH and MED fixes. Skip LOW. One commit per screen.
4. Do not refactor structure. Do not introduce new components. Do not change behavior. Visual fixes only.

Hard stop on TRACK B if any of: (a) a fix would require touching a locked file, (b) a fix would change behavior, (c) you've spent more than 90 minutes total on TRACK B. Log the cutoff in STATUS and move on.

---

## Definition of done for the run

You can stop and consider the run successful if:

- ✅ `docs/results-screen-spec.md` exists and is real (not a stub).
- ✅ `lib/graph/recommender.ts` exists, is tested, tests pass.
- ✅ Results screen has the five sections, builds cleanly, renders on the dev server.
- ✅ Drill route exists, results→drill→re-attempt loop closes.
- ✅ `OVERNIGHT_STATUS.md` is complete and honest — including everything that didn't work.
- ✅ All commits are on the feature branch, none pushed.
- ✅ `pnpm build` succeeds at HEAD of the branch.

TRACK B is a bonus. TRACK A is the run.

---

## How to stop

When you're done (or genuinely stuck on every remaining task):

1. Final `pnpm typecheck && pnpm lint && pnpm build`. If any fail, fix or revert until the branch builds clean.
2. Final commit: `chore: overnight run complete — see OVERNIGHT_STATUS.md`.
3. Print to console: branch name, commit count, status doc path, the 3-5 things the user should check first. Then end.

Do not push. Do not open a PR. The user does that.

---

Begin.