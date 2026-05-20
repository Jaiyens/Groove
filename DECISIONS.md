# Decisions log

A running log of tradeoffs and interpretations made during the overnight build. Each entry: what + why.

## Project root location

Spec shows `groove-web/` as the top-level project directory, but the working dir is already `/Users/panda/Groove`. **Decision**: use `/Users/panda/Groove` as the project root directly; the `package.json` name is `groove-web` per spec. Avoids redundant nesting (`Groove/groove-web/`). Internal structure (`app/`, `components/`, `lib/`, `public/`) follows the spec exactly.

## Next.js version

Spec says "Next.js 14+ with App Router". **Decision**: pinned to `next@14.2.15`. Next 15 changes async params semantics in App Router, which would complicate dynamic routes (`[danceId]`, `[sessionId]`, `[skillId]`). Staying on 14 keeps params synchronous and reduces surprise for Jaiyen tomorrow. There is a known security note on this version; for a local prototype with no backend, it's acceptable. Bump before deploying production.

## Strict TS, no JS escape hatches

`tsconfig.json` uses `strict: true` per spec. No `// @ts-ignore` allowed in committed code — anything that doesn't type-check goes into BLOCKERS.md.

## Dark mode default + iPhone phone frame

`app/layout.tsx` sets `<html className="dark">` unconditionally. `PhoneFrame` wraps content and renders an iPhone-shaped shell at `min-width: 600px` (desktop dev view) and full-bleed below that (real mobile). The 430px width matches iPhone 14 Pro Max width; 932px matches its height.

## Tailwind colors

Custom semantic palette: `bg`, `text`, `accent` with score-color tokens (`accent.green/amber/red`) matching the spec's results screen color-coding rules. Easier to keep score breakdown consistent across screens.

## Testing setup

`npm test` uses Node's native `node --test` runner with `tsx` for TypeScript. No Jest / Vitest dependency needed — keeps the toolchain small and the pure-TS modules (which we'll port to Swift) testable without browser-y test runners.

## Beat tracker scope

Spec says "use Web Audio API to do real-time onset detection". Real onset detection is a research problem with no clean off-the-shelf JS lib. **Decision**: ship the BPM-based phase tracker per the spec's v1 escape hatch ("allow a hardcoded BPM per reference dance fixture") and stub the audio-onset path with a clearly-marked TODO. Real-time onset detection deferred to native iOS where AVFoundation makes this easier. Recorded in OVERNIGHT_SUMMARY.md as a known gap.

## Reference dance media

Spec forbids real TikTok video. **Decision**: generate 3 minimal placeholder MP4s (or omit and use `<video>` poster fallback) — Jaiyen swaps in real footage tomorrow. Codec doesn't matter for the prototype since the camera + skeleton path is what we're demoing.

## Mastery: bootstrap value

For brand-new users with no attempts yet, the recommender needs a value. **Decision**: `getMastery(skillId)` returns `0` for unknown skills. Readiness for a fresh dance is therefore 0% on first launch — matches the "% ready" mental model and surfaces all skills as drill candidates. Documented in `lib/mastery/store.ts`.
