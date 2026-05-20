# Groove — web prototype

iOS-bound app that teaches users to dance TikTok choreography by reading their
body pose via phone camera and scoring their movement against a reference
dance. This repo is the web prototype: a stepping stone before native Swift +
SwiftUI + Apple Vision.

> **Status (2026-05-20, day 2):** real knowledge graph wired in. Practice
> loop rebuilt as copy-along → test → full attempt (Duolingo-style chunk
> progression). Reference video files are still placeholders — Jaiyen drops
> them in next.

## Stack

- **Next.js 14** (App Router) + TypeScript strict
- **Tailwind CSS** with a TikTok-y dark palette
- **MediaPipe Pose Landmarker** via [`@mediapipe/tasks-vision`] for 33-landmark
  body tracking in-browser (WASM)
- **Zod** for runtime validation of the knowledge graph JSON
- **localStorage** for mastery + chunk-progression persistence — no backend

Pure-TS modules (`lib/pose`, `lib/scoring`, `lib/graph`, `lib/mastery`,
`lib/audio`) have zero DOM dependencies; they port to Swift one-for-one.

## Run it

```bash
npm install
npm run dev          # http://localhost:3000
npm run build        # production build
npm test             # 67 unit tests
```

The prototype targets phone form factor; on desktop, the layout sits inside
an iPhone-shaped frame (430×932) so you can see the design as it'll look on
device. On real mobile the frame disappears and the app is full-bleed.

Camera access requires HTTPS in production. Locally, `localhost` is treated
as secure so `npm run dev` works without any flags.

## Practice loop (the new shape)

A dance is taught in three modes that mirror how people actually learn TikTok
choreography:

| Mode | Route | What it does |
| --- | --- | --- |
| **A — copy-along** | `/dance/[id]/chunk/[i]/copy` | Reference video full-bleed, user PIP in corner (Duet-style), audio at 50/75/100% speed. No score. Tap "I got it" → Mode B. |
| **B — test** | `/dance/[id]/chunk/[i]/test` | Camera full-screen, skeleton overlay, reference audio plays, DTW scores just the chunk's pose window. Pass ≥ 70 → next chunk unlocks. |
| **C — full attempt** | `/dance/[id]/full` | Unlocked only when every chunk passes. Audio-only, full-routine DTW. Persists a mastery attempt and routes to `/results`. |

`lib/graph/chunker.ts` is the pure-TS module that takes a routine node and
returns 2–8 `Chunk { startMs, endMs, skills[], label }` segments. Default
target chunk length: 2.5 seconds.

## Surfaces

| Route | What it does |
| --- | --- |
| `/` | Home: greeting, streak (placeholder), 3 dance cards with % ready badges |
| `/dance/[danceId]` | Lesson overview — Duolingo-style chunk progression path |
| `/dance/[danceId]/chunk/[i]/copy` | Mode A copy-along |
| `/dance/[danceId]/chunk/[i]/test` | Mode B scored chunk test |
| `/dance/[danceId]/full` | Mode C full attempt (gated) |
| `/results/[sessionId]` | Big score, per-skill breakdown, auto-recommended drill |
| `/drill/[skillId]` | Timed drill, live effort score, mastery update |

## Architecture quick-glance

```
app/                  ← Next.js App Router pages (UI)
components/           ← React components (UI only)
lib/
  audio/              ← useDanceAudio hook (browser-only)
  pose/               ← MediaPipe wrapper + joint-angle + projection math (Swift-portable)
  scoring/            ← DTW, similarity, scorer, beat tracker (Swift-portable)
  graph/              ← Schema, Zod loader, chunker, readiness, recommender (Swift-portable)
  mastery/            ← localStorage-backed EMA mastery + chunk progression (Swift-portable)
  dances/             ← Hardcoded reference dance fixtures (id + name + artist + video_url only)
public/data/
  knowledge_graph.json        ← real 46-node graph (8 Layer-6 routines)
  reference_dances/*.mp4      ← placeholder media; real footage TBD
tests/                ← node --test runner via tsx (67 tests)
```

## Where the data lives

- **Knowledge graph** — `public/data/knowledge_graph.json`. Bare JSON array
  (no wrapping object); `lib/graph/loader.ts` accepts both this and the legacy
  `{nodes, version, generated_at}` form.
- **Dance fixtures** — `lib/dances/fixtures.ts`. Just `{id, name, artist,
  video_url}`. `id` must equal a Layer-6 routine node id (`routine_*`); the
  routine's `bpm`, `duration_seconds`, `required_skills`, `skill_weights`
  are merged in at runtime via `resolveDance(fixture, graph)`.
- **Mastery** — `lib/mastery/store.ts`. EMA per skill in localStorage.
- **Chunk progression** — `lib/mastery/chunkProgress.ts`. Per-dance unlock
  state in localStorage.
- **Audio** — `lib/audio/danceAudio.ts`. The same mp4 file as the reference
  video; the browser plays the audio track only when the visual isn't shown.

## Adding a new reference dance

1. The dance must already exist as a Layer-6 `routine_*` node in
   `public/data/knowledge_graph.json`.
2. Add a fixture in `lib/dances/fixtures.ts`:
   ```ts
   { id: 'routine_your_dance', name: 'Display name', artist: 'Artist',
     video_url: '/data/reference_dances/your_dance.mp4' }
   ```
3. Drop the mp4 at the referenced path. If absent, the lesson page still
   loads but Mode A shows a "reference video missing" overlay.

## Swapping the knowledge graph

The loader accepts either:

- a bare JSON array (production format from Claude Research), or
- `{ nodes: [...], version, generated_at }` (legacy / hand-built fixtures).

Just overwrite `public/data/knowledge_graph.json` and reload. The Zod
validator throws clearly on any schema deviation, with field path and reason.
If a routine's `id` already matches a `DanceFixture.id`, it'll automatically
appear in the home library.

## Deploy

```bash
vercel --prod        # no env vars required
```

The MediaPipe WASM + model load from CDN (jsdelivr + storage.googleapis.com),
so the app is fully static. Make sure your deploy URL is HTTPS (Vercel default).

## Known stubs

- **Reference dance footage** — directory has only a README. `golden.mp4`,
  `dead_dance.mp4`, `not_cute_anymore.mp4` should be ~15–20s chorus loops with
  audio. Mode A and Mode B/C audio both play from these files.
- **Pose reference data** — Mode B/C still scores against
  `lib/scoring/syntheticReference.ts` (a programmatic neutral-with-motion
  vector sequence). Real per-frame reference pose data per dance should be
  precomputed once we have footage.
- **Per-skill score attribution** — the scorer partitions beats uniformly
  across `dance.required_skills`. Real choreography labels with per-move
  timestamp ranges should replace this partition strategy.
- **Beat tracker** — BPM-driven (hardcoded per routine node). Real-time onset
  detection deferred to iOS native.

See [DECISIONS.md](DECISIONS.md) for the full tradeoff log and
[OVERNIGHT_SUMMARY.md](OVERNIGHT_SUMMARY.md) for current status / next steps.

## License

Private prototype. Don't redistribute reference dance footage.

[`@mediapipe/tasks-vision`]: https://www.npmjs.com/package/@mediapipe/tasks-vision
