# Groove — web prototype

iOS-bound app that teaches users to dance TikTok choreography by reading their
body pose via phone camera and scoring their movement against a reference
dance. This repo is the web prototype: a stepping stone before native Swift +
SwiftUI + Apple Vision.

> **Status (2026-05-20):** overnight prototype. The knowledge graph is a stub;
> the real graph drops in tomorrow as a one-line file replacement (see
> [Swapping in the real knowledge graph](#swapping-in-the-real-knowledge-graph)).

## Stack

- **Next.js 14** (App Router) + TypeScript strict
- **Tailwind CSS** with a TikTok-y dark palette
- **MediaPipe Pose Landmarker** via [`@mediapipe/tasks-vision`] for 33-landmark
  body tracking in-browser (WASM)
- **Zod** for runtime validation of the knowledge graph JSON
- **localStorage** for mastery persistence — no backend

Pure-TS modules (`lib/pose`, `lib/scoring`, `lib/graph`, `lib/mastery`) have
zero DOM dependencies; they port to Swift one-for-one.

## Run it

```bash
npm install
npm run dev          # http://localhost:3000
npm run build        # production build
npm test             # 54 unit tests
```

The prototype targets phone form factor; on desktop, the layout sits inside
an iPhone-shaped frame (430×932) so you can see the design as it'll look on
device. On real mobile the frame disappears and the app is full-bleed.

Camera access requires HTTPS in production. Locally, `localhost` is treated
as secure so `npm run dev` works without any flags.

## Surfaces

| Route | What it does |
| --- | --- |
| `/` | Home: greeting, streak (placeholder), 3 dance cards w/ % ready badges |
| `/practice/[danceId]` | Live camera + pose skeleton + beat-aligned sync score |
| `/results/[sessionId]` | Big score, per-skill breakdown, auto-recommended drill |
| `/drill/[skillId]` | Timed drill, live effort score, mastery update |

## Architecture quick-glance

```
app/                  ← Next.js App Router pages (UI)
components/           ← React components (UI only)
lib/
  pose/               ← MediaPipe wrapper + joint-angle math (Swift-portable)
  scoring/            ← DTW, similarity, scorer, beat tracker (Swift-portable)
  graph/              ← Schema, Zod loader, readiness, recommender (Swift-portable)
  mastery/            ← localStorage-backed EMA mastery tracker (Swift-portable)
  dances/             ← Hardcoded reference dance fixtures
public/data/
  knowledge_graph.json        ← stub today, real graph tomorrow
  reference_dances/*.mp4      ← placeholder media; real footage TBD
tests/                ← node --test runner via tsx
```

## Swapping in the real knowledge graph

When `knowledge_graph.json` is delivered tomorrow morning by Claude Research:

1. **Replace** `public/data/knowledge_graph.json` with the real file.
2. **Reload** the app. The Zod validator in
   [lib/graph/loader.ts](lib/graph/loader.ts) runs on load and will throw with a
   precise path + reason if the schema doesn't match (e.g.
   `node "x_y_z" has skill_weight for "..." but it's not in required_skills`).
   Fix the deviations in the real file (or in the validator if the schema has
   intentionally evolved).
3. **Update** `lib/dances/fixtures.ts` so each `required_skills` array points
   at real graph node IDs instead of `stub_*` placeholders. The validator does
   not check the dance fixtures, so this is on you.
4. *(Optional)* Rename one routine node's `id` to equal `fixture_apt` (or any
   dance fixture id) — this exercises the weighted-readiness path. Otherwise
   readiness falls back to uniform weights across `dance.required_skills`,
   which is fine.

That's it for the graph — no code changes required.

## Swapping in real reference video

1. Drop short MP4 clips into `public/data/reference_dances/` with the names
   referenced by `lib/dances/fixtures.ts` (`apt.mp4`, `espresso.mp4`,
   `renegade.mp4`).
2. The practice and drill screens auto-pick them up via the standard
   `<video src>` URL. If a file is missing, the PiP gracefully shows a "no
   video / placeholder" panel and the rest of the loop still works.
3. **Important:** do not commit real TikTok video — use original recordings
   or licensed footage. Spec hard rule #3.

## Deploy

```bash
vercel --prod        # no env vars required
```

The MediaPipe WASM + model load from CDN (jsdelivr + storage.googleapis.com),
so the app is fully static. Make sure your deploy URL is HTTPS (Vercel default).

## Known stubs (today's overnight build)

- **Knowledge graph** — 8-node stub covering all 6 layers. Real graph arrives
  tomorrow.
- **Reference dance audio + pose data** — the practice/drill scoring compares
  the user against a programmatically-generated "neutral with subtle motion"
  reference (`lib/scoring/syntheticReference.ts`). Replace with precomputed
  pose data per reference clip once footage is in.
- **Per-skill score attribution** — the scorer partitions beats uniformly
  across `dance.required_skills`; real choreography labels with per-move
  timestamp ranges will replace this partition strategy.
- **Beat tracker** — BPM-driven (hardcoded per fixture). Real-time audio onset
  detection (`AnalyserNode`) is deferred to iOS native where AVFoundation
  makes it cleaner.
- **Reference videos** — directory is empty; placeholder UI shows when files
  are missing.

See [DECISIONS.md](DECISIONS.md) for the full set of tradeoffs and
[OVERNIGHT_SUMMARY.md](OVERNIGHT_SUMMARY.md) for what works and what doesn't.

## License

Private prototype. Don't redistribute reference dance footage.

[`@mediapipe/tasks-vision`]: https://www.npmjs.com/package/@mediapipe/tasks-vision
