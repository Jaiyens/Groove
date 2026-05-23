# SPECK — overnight rebuild of the Gemini scoring data layer

## Read this first

You are working overnight. The user is asleep. **Aggressive mode: keep going, try alternatives, ship what works.** Do not stop and ask. If something fails, document the failure, then try something else. Only stop when (a) you have shipped everything in this spec and your spare-time pickups, or (b) you hit something that genuinely cannot be solved without the user.

Branch off `gemini-timeout-and-webm-repair`. New branch: `overnight-data-rebuild`. One commit per file group. Do not push to main.

When you finish each group, paste a diff summary to the terminal so the user can read the trail when they wake up. End the run with a status report at `/docs/overnight-status.md` covering: what shipped, what got skipped and why, what needs human validation, what surprised you.

---

## The big picture — why this exists

Five rounds of scoring work have shipped. The deterministic layer is calibrated. The prompt is recalibrated. The components are honest. The headline derives from components. The motion-onset detector works. The webm-repair library inferred the right duration.

**But the data going to Gemini is still wrong.** Tonight's validation showed:

- The webm-repair library correctly inferred `inferredDurationSec: 6.712` from the raw attempt blob.
- But `finalizeWebmDuration` then opens the same blob in a hidden `<video>` and the browser reports 1.378s after the MAX_SAFE_INTEGER seek trick.
- Everything downstream uses 1.378s. The attempt gets trimmed to ~1s. Gemini sees one second of a person starting to move and correctly concludes "they didn't dance."
- The result: `is_actually_dancing: false`, overall_score: 10, on what was a sincere 7-second attempt.

The data layer is the blocker. Until Gemini sees a real 7-second performance, every downstream calibration is fitting to noise.

**Your mission:** fix the data layer once and for all, then ship the side-by-side composition architecture that makes Gemini's job easier, then unify the mirror state across all three surfaces, then diagnose the always-GROOVY callout bug. In that order. Each group's acceptance gates the next.

---

## Hard rules

1. The architecture stays at the boundaries: MediaPipe live callouts during the dance, Gemini post-attempt verdict, MediaPipe fallback on Gemini failure.
2. All diagnostic logging from rounds 1–5 stays. Add to it. Do not remove `[gemini-client]`, `[gemini-score]`, `[deterministic]`, or `[callout-engine]` lines.
3. The deterministic scoring layer (`displayedOverall` = mean of components, components nullable for upper-body-only, NOT_DANCING tier when canary fails) is validated. Do not modify the formula.
4. The Gemini prompt is validated to the extent it can be without clean data. Do not rewrite the prompt body. Group 5 may add NEW clauses for the composite-video case, but the existing canary, floor-35, tier-capped trouble spots, and conditional-positive-insight clauses STAY.
5. Mobile-first. Verify at 390px in DevTools.
6. Every group must keep tests passing. If a group ships and tests fail, revert that group and write up what went wrong in the status doc.

---

## Group 1 — Trust the webm-repair inferred duration

**Why first:** until this lands, every other group is debugging on broken data. This is a one-file change with a one-file test update. Highest leverage of any task in this spec.

### The bug, restated for clarity

In `lib/scoring/gemini/client.ts`, `trimAttemptForOnset` currently does this:

1. Call `repairWebmDuration(blob)` — returns a `RepairWebmResult` with the blob and a log line showing `inferredDurationSec: 6.712` (correct).
2. Call `finalizeWebmDuration(blob)` — opens a hidden `<video>` element, seeks to MAX_SAFE_INTEGER, reads `video.duration`. On the test device, this returns 1.378s (wrong, ~5s short).
3. Use `finalizedDurationSec` (1.378s) as the authoritative duration for motion-onset scanning and trim window calculation.
4. Result: attempt gets trimmed to ~1.35s. Gemini sees 1 second of video. Verdict: not dancing.

The repair library already knows the right answer. The browser doesn't. **Use the library's answer.**

### MODIFIED: `lib/scoring/gemini/webmFix.ts`

The `RepairWebmResult` type must expose `inferredDurationSec` on the return value. Right now it's logged but may not be on the typed return. Make it public:

```typescript
export type RepairWebmResult = {
  blob: Blob;
  repaired: boolean;
  bytesBefore: number;
  bytesAfter: number;
  inferredDurationSec: number | null;  // NEW or PROMOTED to public
};
```

If the field is already there, this group does nothing in this file. If not, surface it. The value comes from the existing EBML scan that reads the last Cluster Timecode and TimecodeScale.

### MODIFIED: `lib/scoring/gemini/client.ts`

Inside `trimAttemptForOnset`, replace the linear "repair then finalize" pipeline with a duration-source decision:

```typescript
const repairResult = await repairWebmDuration(attemptBlob);
const inferred = repairResult.inferredDurationSec;

let authoritativeDurationSec: number;
let durationSource: 'webm-repair-inferred' | 'browser-finalize';
let finalizedDurationSec: number | null = null;

if (typeof inferred === 'number' && Number.isFinite(inferred) && inferred >= 0.5) {
  authoritativeDurationSec = inferred;
  durationSource = 'webm-repair-inferred';
} else {
  const finalized = await finalizeWebmDuration(repairResult.blob);
  finalizedDurationSec = finalized.durationAfter;
  authoritativeDurationSec = finalized.durationAfter;
  durationSource = 'browser-finalize';
}

console.log('[gemini-client] motion-onset trimAttempt: duration-source', {
  source: durationSource,
  durationSec: authoritativeDurationSec,
  inferredDurationSec: inferred,
  finalizedDurationSec,
});
```

Everything downstream (motion-onset scanning, trim window math, scan-end calculation) uses `authoritativeDurationSec`.

**Do NOT modify `trimReferenceClientSide`.** The reference path reads from an mp4 URL and `video.duration` works correctly there.

### NEW: `tests/durationSource.test.ts`

Three test cases:
1. `inferredDurationSec` is 6.7 → uses `webm-repair-inferred`, downstream sees 6.7.
2. `inferredDurationSec` is null → falls back to `finalizeWebmDuration`, downstream sees whatever the browser produced (mock returning 7.0).
3. `inferredDurationSec` is 0.2 (implausibly short) → falls back to `finalizeWebmDuration`. Implausibly short means < 0.5s.

Use mocks. Don't try to construct real webm files in tests.

### Acceptance

- All existing tests still pass.
- The 3 new tests pass.
- After this lands, a sincere attempt should show in the terminal:
  - `[gemini-client] motion-onset trimAttempt: duration-source { source: 'webm-repair-inferred', durationSec: ~6.7 }`
  - `[gemini-client] motion-onset trimAttempt: scanning { durationSec: ~6.7 }`
  - `[gemini-client] motion-onset trimAttempt: done { blobBytes: 1.5MB–2MB range }`

Commit message: `fix(duration-source): trust webm-repair inferred duration over browser seek`

---

## Group 2 — Mirror unification across all three surfaces

**Why second:** mirror state has to be coherent before composite-video composition (Group 4) bakes mirror choices into the rendered output.

### The bug

Three surfaces render the reference video. They currently have two different mirror states:

| Surface | Mirror state | Status |
|---|---|---|
| Mode A REF panel | `transform: scaleX(-1)` hardcoded | Mirrored ✓ |
| Holding-screen REF panel | No transform | NOT mirrored ✗ |
| Gemini reference input | Mirrored via Round 3's `trimReferenceClientSide` flip | Mirrored ✓ |

### NEW: `lib/preferences/mirror.ts`

```typescript
const KEY = 'groov_mirror_enabled';
const EVENT = 'groov:mirror-changed';

export function getMirrorEnabled(): boolean {
  if (typeof localStorage === 'undefined') return true;
  const v = localStorage.getItem(KEY);
  return v === null ? true : v === 'true';
}

export function setMirrorEnabled(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(KEY, String(enabled));
  window.dispatchEvent(new CustomEvent(EVENT, { detail: enabled }));
}

export function onMirrorChanged(handler: (enabled: boolean) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
```

### MODIFIED: Mode A REF panel

Find with `grep -r "scaleX(-1)" app/dance components/`. Replace hardcoded transform with state-driven:

```tsx
const [mirror, setMirror] = useState(getMirrorEnabled());
useEffect(() => onMirrorChanged(setMirror), []);
<video style={{ transform: mirror ? 'scaleX(-1)' : 'none' }} />
```

Skeleton overlay must apply the same transform from the same source.

### MODIFIED: Holding-screen REF panel

Likely `components/scoring/SideBySideHoldingScreen.tsx`. Apply mirror to REF panel only. **Do not add a second flip to the attempt side** — the front-camera already mirrors it at the hardware level.

### MODIFIED: `lib/scoring/gemini/client.ts`

`trimReferenceClientSide` currently hardcodes `ctx.scale(-1, 1)`. Change to read `getMirrorEnabled()` at call time. Update `referenceMirrored` in the API payload to reflect actual state.

### MODIFIED: Mode A controls

If a mirror toggle exists, migrate it to `setMirrorEnabled()`. If not, add one with a `FlipHorizontal` icon from lucide-react. Tooltip: "Mirror reference (recommended)."

### Acceptance

- Toggling in Mode A flips Mode A REF panel immediately.
- Holding screen REF panel reflects the same state.
- Gemini composite reflects the same state.
- Default ON. Persists across reloads.
- All existing tests pass. Add one test for `getMirrorEnabled` defaulting to true.

Commit message: `feat(mirror): unify mirror state across mode A, holding screen, gemini input`

---

## Group 3 — Server-side webm repair fallback

**Why third:** Group 1 handles the case where `fix-webm-duration` can infer a duration. We need a server-side fallback for when it can't.

### Architecture

New endpoint: `POST /api/repair-webm`. Accepts base64 webm, returns re-encoded webm with fixed duration via ffmpeg.wasm. Invoked from client ONLY when `repairWebmDuration` returns null AND `finalizeWebmDuration` also fails.

### NEW: `app/api/repair-webm/route.ts`

Use `@ffmpeg/ffmpeg` (ffmpeg.wasm). Install `@ffmpeg/ffmpeg` and `@ffmpeg/util` if not present.

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

export const runtime = 'nodejs';
export const maxDuration = 30;

let ffInstance: FFmpeg | null = null;

async function getFFmpeg() {
  if (ffInstance) return ffInstance;
  const ff = new FFmpeg();
  await ff.load();
  ffInstance = ff;
  return ff;
}

export async function POST(req: NextRequest) {
  const { webmBase64 } = await req.json();
  if (!webmBase64) return NextResponse.json({ error: 'missing webmBase64' }, { status: 400 });

  try {
    const ff = await getFFmpeg();
    await ff.writeFile('in.webm', await fetchFile(Buffer.from(webmBase64, 'base64')));
    await ff.exec(['-i', 'in.webm', '-c:v', 'copy', '-c:a', 'copy', '-fflags', '+genpts', 'out.webm']);
    const out = await ff.readFile('out.webm');
    const buf = Buffer.from(out as Uint8Array);
    return NextResponse.json({
      webmBase64: buf.toString('base64'),
      bytesBefore: Buffer.from(webmBase64, 'base64').length,
      bytesAfter: buf.length,
    });
  } catch (err) {
    console.error('[repair-webm] failed', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
```

If ffmpeg.wasm install fails or won't run, try `child_process.spawn('ffmpeg', ...)` with a system ffmpeg. Document what worked in the status report.

### MODIFIED: `lib/scoring/gemini/client.ts`

After Group 1's duration-source decision, if `durationSource === 'browser-finalize'` AND the result is still implausible (< 0.5s, NaN, > 60s), invoke server-side repair as last-resort fallback. Add `'server-repair'` as third value of `durationSource`.

### Acceptance

- Endpoint exists and returns 200 on valid webm.
- Returns 400/500 with clear errors on bad input.
- Client fallback fires only when both prior paths fail.
- New test: `tests/repairWebmRoute.test.ts` with mocked happy path.

Commit message: `feat(repair-webm): server-side ffmpeg.wasm fallback for broken webm duration`

---

## Group 4 — Side-by-side composite video

**Why fourth:** depends on Groups 1, 2, 3 landing.

### The argument

Today Gemini gets two separate videos and has to mentally align them. Composite approach: render a single video with REFERENCE on left half, ATTEMPT on right half, audio-synced to reference. Gemini does visual comparison instead of temporal inference. Halves the API payload.

### NEW: `lib/scoring/gemini/composite.ts`

```typescript
export type CompositeResult =
  | { kind: 'success'; blob: Blob; mimeType: string; durationSec: number }
  | { kind: 'failure'; reason: string };

export async function renderSideBySideVideo(args: {
  referenceUrl: string;
  attemptBlob: Blob;
  mirror: boolean;
  motionOnsetRefSec: number;
  motionOnsetAttemptSec: number;
  chunkDurationSec: number;
}): Promise<CompositeResult>;
```

Algorithm:
1. Open both videos as hidden `<video>` elements. `playsInline`, attempt `muted`, reference `crossOrigin: anonymous`.
2. Verify both durations valid (not NaN, not 0, not > 60s). Else return failure.
3. Seek both to motion-onset starts. Wait for `seeked` events.
4. Canvas 1280×720. Reference draws to left half (640×720), attempt to right half. Letterbox to preserve aspect ratio.
5. Build output MediaStream: canvas video track + reference audio track.
6. Apply mirror to reference draw if `mirror === true`.
7. MediaRecorder with `video/webm;codecs=vp9`.
8. Play both. Each animation frame, draw both into halves. Stop when `chunkDurationSec` elapsed.
9. Return blob.

10-second internal timeout. Heavy `[composite]` logging. Never throw to caller — failure degrades to two-video.

### MODIFIED: `lib/scoring/gemini/client.ts`

```typescript
const composite = await renderSideBySideVideo({
  referenceUrl,
  attemptBlob: trimmedAttempt.blob,
  mirror: getMirrorEnabled(),
  motionOnsetRefSec: trimmedReference.motionOnsetSec ?? 0,
  motionOnsetAttemptSec: trimmedAttempt.motionOnsetSec ?? 0,
  chunkDurationSec: Math.min(7, attemptDurationSec),
});

if (composite.kind === 'success') {
  return await sendCompositeToGemini(composite.blob, /* metadata */);
} else {
  console.log('[gemini-client] composite failed, falling back to two-video', { reason: composite.reason });
  return await sendTwoVideoToGemini(trimmedReference, trimmedAttempt, /* metadata */);
}
```

### NEW: `app/api/score-gemini-composite/route.ts`

New endpoint for composite case. Same Zod schema. Different prompt. Reuses retry logic, failure classification, logging from `/api/score-gemini`.

### MODIFIED: `lib/scoring/gemini/prompt.ts`

Add `buildCompositePrompt(args)`. Composite-specific framing:

```
You are watching a single video that shows two performances side by side. The LEFT half shows the choreography reference. The RIGHT half shows the user's attempt. Both performances start at the same moment — the first beat of the choreography. You do not need to align them in time; alignment is built into the video.

Compare the right half to the left half. Grade the user's attempt based on how closely the right half matches the left half throughout the video.

Mirror state: {{mirror state}}. If mirror is enabled, the LEFT half (reference) has been horizontally flipped to match the user's selfie-camera orientation on the RIGHT half. Left and right body parts in both halves correspond directly.
```

Then existing canary, floor-35, tier-cap, conditional-positive-insight, DO-NOT-INCLUDE for hand details / execution sharpness, DEFAULTING ON UNCERTAINTY — all preserved, adapted to composite framing.

### Acceptance

- `renderSideBySideVideo` returns success on happy-path mock, failure (no throw) on edge cases.
- `/api/score-gemini-composite` returns valid `GeminiScore`.
- Client falls back to two-video on failure.
- `tests/composite.test.ts` with 3+ cases.
- `tests/compositePrompt.test.ts` verifying new framing + preserved invariants.
- All existing tests pass.

Commit message: `feat(composite): side-by-side video composition + new prompt branch`

---

## Group 5 — Spare-time pickup: callout-always-GROOVY diagnosis

**Runs only if Groups 1–4 done and tests pass.**

The `[callout-engine]` 4-layer logging should produce mixed-tier output. Tonight's log showed mostly GROOVY/PERFECT with `windowMax` in 0.95–0.999. Question: is the similarity stream saturated or are thresholds wrong?

You can't run the app overnight. Audit the logic.

### MODIFIED: `lib/scoring/callouts/calloutEngine.ts`

Look at how `windowMax` is computed. Check:

1. Per-frame similarity normalized to bias high? `1 - distance` with small distances saturates at 1.0.
2. Window taking max of wide window, picking outliers?
3. Tier thresholds (`>= 0.95 → GROOVY`) calibrated to actual range?

Write findings to `/docs/callout-tier-diagnosis-overnight.md`. Three possible diagnoses:

- **(A) Similarity saturated.** Investigate `lib/scoring/mediapipe/perFrame.ts` or `lib/scoring/poseSimilarity.ts`.
- **(B) Window too generous.** Tighten to ±150ms, use median.
- **(C) Thresholds too low.** Bump GROOVY to 0.97, PERFECT to 0.92, GREAT to 0.85.

**Do NOT change thresholds without writing diagnosis first.** Three rounds of guessing failed. Diagnosis is the deliverable; the fix is next-day's spec.

If you can confidently identify the cause from code alone, write the fix as a separate commit tagged `experimental(callout-tier):` so it can be reverted without losing diagnosis.

### Acceptance

- `/docs/callout-tier-diagnosis-overnight.md` identifies one of (A), (B), (C), or explains why none apply.
- Any fix is in its own `experimental` commit.

Commit message: `docs(callout-tier): overnight diagnosis of always-GROOVY behavior`

---

## End-of-run report

Write `/docs/overnight-status.md`:

1. **Shipped:** every group landed, with commit hash + one-line summary.
2. **Skipped:** every group that didn't land, with why.
3. **Surprises:** anything different from spec.
4. **Needs human validation:** every acceptance requiring live camera + Gemini. Group 1 needs sincere attempt to confirm `durationSec: ~6.7`. Group 2 needs visual check of three surfaces. Group 4 needs sincere attempt to see if composite improves accuracy.
5. **What I'd do next:** honest opinion.

Commit message: `docs(overnight): status report`

---

## Working agreement

You are working aggressively. That means:

- If `fix-webm-duration` has a bug preventing Group 1: try monkey-patching, try inline EBML scan, try Group 3's server-side route as primary instead of fallback. Document.
- If `@ffmpeg/ffmpeg` won't install or run: try `child_process.spawn`. If ffmpeg isn't on Vercel runtime: try a hosted service. Document.
- If `renderSideBySideVideo` produces corrupted video: try different codec, dimensions, timeslice. Document.
- If you genuinely can't progress on a group: skip to next. Don't get stuck.
- If you finish everything: spare time → Group 5 first, then write tests for any gap, then `/docs/known-issues.md` rolling up everything currently fragile.

The user values intellectual honesty. If something didn't work and you can't fix it, say so plainly. Don't invent a story about why it's fine.

Branch state when you stop: commits on `overnight-data-rebuild`, working tree clean, tests passing on whichever groups landed. Do not push to main.

Good luck.