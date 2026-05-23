# UI / UX audit — overnight polish pass

Catalogued before the polish pass. Findings split into SAFE (will be auto-fixed in this branch) and FLAG (deferred for human review). Off-limits per SPECK: `lib/scoring/`, `app/api/score-gemini*`, `app/api/repair-webm`, `lib/scoring/gemini/`, callout overlay drawing, dual-skeleton drawing.

Token reference: palette tokens live in `tailwind.config.ts`. Notable ones — `coral` = `#FF1F8E`, `ink` = `#0A0A0A`, `ink-muted` = `#6B6B6B`, `ink-dim` = `#A8A8A6`, `cream` = `#F8F8F6`, `cream-card` = `#FFFFFF`, `accent-amber` = `#FFB800`, `accent-red` = `#FF3E3E`, `accent-green` = `#00C26B`. The dark-theme `text-text-muted` (= `#9b9ba1`) is only legible on dark backgrounds.

---

## A11Y

### [A11Y] app/error.tsx:20
What: Body copy uses `text-text-muted` (the dark-theme color) but the root layout is `bg-cream text-ink` (light). #9b9ba1 on #F8F8F6 fails WCAG.
Why it matters: Error message is hard to read on the light global background.
Fix: Replace `text-text-muted` with `text-ink-muted`.
Safety: SAFE

### [A11Y] app/not-found.tsx:7
What: Same dark-theme `text-text-muted` on the light body background.
Why it matters: 404 explanatory text is washed out on cream.
Fix: Replace `text-text-muted` with `text-ink-muted`.
Safety: SAFE

### [A11Y] components/library/HeroCard.tsx:24
What: "featured" label uses `text-gray-500` — not a project token (the palette is `cream / ink / coral / accent / slate`).
Why it matters: Renders as the Tailwind default gray (#6b7280), close to but not the project's `ink-muted` (#6B6B6B). Drifts the palette.
Fix: Replace `text-gray-500` with `text-ink-muted`.
Safety: SAFE

### [A11Y] components/StartOverlay.tsx:96-105
What: Countdown number changes from 3→2→1→GO inside a dialog with no `aria-live`. Screen readers won't announce phase transitions.
Why it matters: AT users get no cue that the dance is about to start.
Fix: Wrap the countdown / GO div in `aria-live="polite" aria-atomic="true"`.
Safety: SAFE

### [A11Y] components/SubmitModal.tsx (modal contract)
What: Dialog has `role="dialog"`/`aria-modal="true"` but no focus trap or Escape-to-close.
Why it matters: Keyboard users can tab out of the modal; no quick dismiss.
Fix: Add focus trap + Escape handler.
Safety: FLAG — changes modal contract, needs UX review.

### [A11Y] components/lesson/TikTokEmbed.tsx
What: iframe title is the generic literal "Original TikTok" regardless of which dance.
Why it matters: SR users with multiple embeds in history can't disambiguate.
Fix: Take a `danceName` prop and template the title.
Safety: FLAG — prop addition + caller updates.

### [A11Y] components/ChunkProgression.tsx / components/lesson/ChunkPath.tsx
What: Locked chunks render `<Link aria-disabled href="#">` with manual preventDefault.
Why it matters: Non-standard disabled pattern; SRs may still announce as link.
Fix: Render as `<button disabled>` instead.
Safety: FLAG — element type change, needs styling sweep.

### [A11Y] app/dance/[danceId]/pick-dancer/page.tsx:131
What: Disabled submit-style button has no visible disabled state.
Why it matters: Tap appears to do nothing with no affordance.
Fix: Add `disabled:opacity-60 disabled:cursor-not-allowed`.
Safety: FLAG — verify which buttons get this; could be wider rule.

---

## DEAD CODE

### [DEAD] components/IntroSplash.tsx:39 / components/Logo.tsx:48
What: `focusable="false"` on SVG elements. SVGs are already not focusable by default outside IE.
Why it matters: Tiny noise but the SVG is `aria-hidden` and decorative — the attr is purely redundant.
Fix: Remove the `focusable="false"` attribute.
Safety: SAFE

### [DEAD] components/FramingToast.tsx (`active` prop on SilhouetteGuide)
What: `active` prop defaults to false and the only call site passes `active={isFramed}` — let me actually verify the boundaries before removing.
Why it matters: Possibly unused branch.
Fix: Audit call sites and trim if confirmed unused.
Safety: FLAG — needs careful trace; not worth a risky touch tonight.

### [DEAD] components/SkeletonOverlay.tsx — `landmarks` in useEffect deps
What: Effect depends on `landmarks` but reads from refs.
Why it matters: Causes redundant redraws.
Fix: Trim deps.
Safety: FLAG — perf-flavoured change in a render-heavy path; defer.

---

## CONSISTENCY

### [CONSISTENCY] components/library/SubmitFab.tsx:13
What: `bg-[#FF1F8E]` — exact value of the `coral` token.
Why it matters: Inline hex bypasses the palette.
Fix: Replace `bg-[#FF1F8E]` with `bg-coral`.
Safety: SAFE

### [CONSISTENCY] components/ResultsCard.tsx:81-84 (scoreColorClass)
What: Tier colors use arbitrary hex `[#FF1F8E]`, `[#A3E635]`, `[#F59E0B]`, `[#EF4444]`.
Why it matters: `#FF1F8E` is exactly `coral`; `#F59E0B` is close to but not `accent-amber` (#FFB800); `#EF4444` is close to but not `accent-red` (#FF3E3E); `#A3E635` has no token.
Fix: The file comment explicitly says hexes are kept local on purpose. Leave as-is.
Safety: FLAG — by author intent, the local hex pinning was the call.

### [CONSISTENCY] app/onboarding/frame-check/page.tsx:139,174 + components/FramingToast.tsx:160
What: `#FF3E7F` appears 3 times for framing accent; not a token.
Why it matters: Slightly different pink from coral (#FF1F8E). Either should become a new "framing pink" token or unify with coral.
Fix: FLAG — judgment call on whether the framing UI deliberately uses a different pink.
Safety: FLAG

### [CONSISTENCY] components/ProgressBar.tsx (from-accent)
What: Uses `from-accent` (resolves to coral via the default `accent: '#FF1F8E'`).
Why it matters: `accent` token is a duplicate of `coral`; explicit token clearer.
Fix: FLAG — minor, requires inspection of consumers.
Safety: FLAG

### [CONSISTENCY] app/results/[sessionId]/page.tsx — card padding
What: Results card uses p-6, breakdown p-4, recommendation p-5.
Why it matters: Visually inconsistent siblings.
Fix: FLAG — normalisation affects vertical rhythm; needs design call.

---

## TYPOGRAPHY

### [TYPO] components/library/SectionHeader.tsx:11
What: `h2` is `leading-none` — fine for one-line titles, breaks for two-line ones.
Why it matters: Cramped leading on wrap.
Fix: Replace `leading-none` with `leading-tight`.
Safety: SAFE

### [TYPO] components/ReferenceVideo.tsx:46
What: `text-[10px]` error caption already has `leading-tight` — fine. No change.
Safety: N/A

### [TYPO] components/submit/SubmitModal.tsx:152
What: `text-[30px]` arbitrary instead of `text-3xl`.
Why it matters: Bypasses scale.
Fix: FLAG — sizing tweak, verify intent.

### [TYPO] Project-wide `text-[10px]` for uppercase labels
What: A12+ pages use `text-[10px] uppercase tracking-widest` as section labels.
Why it matters: It is actually a consistent pattern across the app. Not a real inconsistency.
Fix: No action.
Safety: N/A

---

## SPACING

### [SPACING] app/results/[sessionId]/page.tsx:162
What: `text-[11px]` for a single muted line.
Why it matters: Arbitrary size, but `text-xs` would round to 12px and the layout was tuned to 11.
Fix: FLAG — visual measurement needed.

### [SPACING] header heights across drill/test/copy pages
What: 50px / 56px / 88px header bars on similar pages.
Why it matters: Inconsistent.
Fix: FLAG — layout coordination.

---

## MOBILE

### [MOBILE] components/VolumeControl.tsx:38
What: Speaker button is `h-9 w-9` (36 px). Below the 44 px tap-target rule.
Why it matters: Mute toggle hard to hit on phone.
Fix: FLAG — used inside a `h-11` header row; bumping to `h-11` shifts the header layout.

### [MOBILE] app/dance/[danceId]/page.tsx:129 / app/drill/[skillId]/page.tsx:222 / app/results/[sessionId]/page.tsx:86
What: Back buttons are `h-10 w-10` / `h-9 w-9`. Below 44 px.
Why it matters: Same as above.
Fix: FLAG — positioned absolutely with `top-[...]` offsets that account for current size; bumping needs offset rebalance.

### [MOBILE] components/library/RecentList.tsx:31
What: Row press feedback is `active:opacity-70`, neighbours use `active:scale-[0.99]`.
Why it matters: Inconsistent affordance.
Fix: FLAG — judgment call (the row has a separate poster, scaling the whole row would scale that too).

---

## INTERACTION

### [INTERACTION] app/error.tsx + app/not-found.tsx — call-to-action button on light background
What: `bg-bg-card text-white` link on the cream body is dark-on-light, but `bg-bg-card` is `#161618`.
Why it matters: Actually fine — dark pill with white text.
Fix: No action.
Safety: N/A

---

## Flagged for human review (top 5)

These are the highest-leverage findings that need a human eye:

1. **FramingToast / frame-check pink (`#FF3E7F`)** — three call sites; is this a deliberate "framing accent" or a coral drift? Either way, give it a token.
2. **Touch targets below 44px on back buttons + VolumeControl** — fixing requires header-row layout retune.
3. **Modal focus trap + Escape-to-close (SubmitModal, StartOverlay)** — proper a11y modal contract.
4. **Disabled link pattern in ChunkProgression / ChunkPath** — convert to `<button disabled>` to match WCAG.
5. **Header height drift across drill/test/copy pages (50 / 56 / 88 px)** — pick one.
