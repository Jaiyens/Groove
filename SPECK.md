# Groove web prototype, overnight build

You are building the web prototype of **Groove**, an iOS-bound app that teaches users to dance TikTok choreography by using their phone camera to detect body pose and scoring their movement against a reference dance.

This is an overnight unattended build. Work autonomously. Make sensible decisions when unspecified. Document every decision you make in `DECISIONS.md`. If you genuinely cannot proceed, write the blocker to `BLOCKERS.md` and continue on the next task.

---

## Context you must respect

1. **A knowledge graph of ~60 dance skills is being generated separately via Claude Research and will be available tomorrow morning as `knowledge_graph.json`.** You do NOT have it tonight. DO NOT invent dance skills or pedagogy. DO NOT hardcode a skill tree. Build everything to consume the graph from a typed interface, with a stub fixture in place. When the real graph arrives, swapping the stub for the real file should be a one-line change.

2. **The web prototype is a stepping stone to iOS native (Swift + SwiftUI + Apple Vision 3D body pose).** Architect with portability in mind: keep DTW scoring, joint-angle math, and graph logic in pure TypeScript modules with no DOM dependencies, so they translate directly to Swift later. UI code can be web-specific.

3. **The product shape is locked. Do not deviate.**
   - Open app → library of trending TikTok dances
   - Pick one → camera on, skeleton overlay on user, reference dancer in corner
   - Live sync score updates every beat
   - Results screen shows per-move breakdown, weak move auto-becomes a 90s drill
   - Tap-loop between dance and drill

4. **Visual language: dark mode, TikTok-native aesthetic, iPhone format (max-width 430px, mobile-first).** Reference: PushUp Time, Pushscroll, STEEZY, Duolingo. Black backgrounds, bold sans-serif, big numbers for scores, single-purpose screens, full-bleed camera view in the practice screen.

---

## Stack

- **Next.js 14+ with App Router**, TypeScript strict mode
- **Tailwind CSS** for styling
- **MediaPipe Pose Landmarker** (`@mediapipe/tasks-vision`) for pose extraction in browser via WASM
- **No external state management** — React Context + useReducer is sufficient
- **localStorage** for mastery tracking persistence (no backend yet)
- **Vercel deployment** ready — no env vars required for v1

---

## Repo structure (build this exactly)

```
groove-web/
├── app/
│   ├── layout.tsx                  # Root layout, dark mode default, viewport meta
│   ├── page.tsx                    # Home / dance library screen
│   ├── practice/[danceId]/page.tsx # Live practice screen with camera
│   ├── results/[sessionId]/page.tsx# Results screen
│   ├── drill/[skillId]/page.tsx    # Skill drill screen
│   └── globals.css                 # Tailwind imports + CSS vars
├── components/
│   ├── DanceCard.tsx               # Card showing a dance + % ready
│   ├── SkeletonOverlay.tsx         # Renders pose landmarks on canvas
│   ├── ReferenceVideo.tsx          # Picture-in-picture reference dance video
│   ├── LiveScore.tsx               # Big number score readout
│   ├── CorrectionToast.tsx         # "Left elbow higher" style hints
│   ├── ProgressBar.tsx             # Beat progress along the dance
│   ├── ScoreBreakdown.tsx          # Per-move score bars (body roll 94, etc.)
│   ├── BottomNav.tsx               # Home / Trophy / Stats / Profile
│   └── PhoneFrame.tsx              # iPhone bezel for desktop development view
├── lib/
│   ├── pose/
│   │   ├── poseExtractor.ts        # MediaPipe wrapper, returns landmarks per frame
│   │   ├── jointAngles.ts          # Convert landmarks to joint-angle vectors
│   │   └── types.ts                # PoseLandmark, JointAngleVector types
│   ├── scoring/
│   │   ├── dtw.ts                  # Dynamic Time Warping, pure function
│   │   ├── similarity.ts           # Cosine similarity on joint-angle vectors
│   │   ├── scorer.ts               # End-to-end: user frames + reference → 0-100 score
│   │   └── beatTracker.ts          # Audio analysis for beat detection (use Web Audio API)
│   ├── graph/
│   │   ├── types.ts                # SkillNode, KnowledgeGraph interfaces matching the schema below
│   │   ├── loader.ts               # Load + validate graph JSON (Zod schema)
│   │   ├── recommender.ts          # Given mastery scores, pick next drill
│   │   └── readiness.ts            # Compute "% ready" for a dance given current mastery
│   ├── mastery/
│   │   ├── store.ts                # localStorage-backed mastery tracker
│   │   └── types.ts                # MasteryRecord, AttemptRecord
│   └── dances/
│       ├── fixtures.ts             # 3 hardcoded reference dances with placeholder skill IDs
│       └── types.ts                # Dance, DanceMetadata
├── public/
│   ├── data/
│   │   ├── knowledge_graph.json    # STUB: paste real graph here tomorrow morning
│   │   └── reference_dances/       # 3 placeholder mp4 files (use any short clip)
│   └── pose-models/                # MediaPipe model files cached locally
├── DECISIONS.md                    # You write this as you go
├── BLOCKERS.md                     # You write this if anything truly blocks you
├── README.md                       # How to run, deploy, and swap in the real graph
└── package.json
```

---

## The knowledge graph schema (use exactly this for the stub and the type definitions)

```typescript
// lib/graph/types.ts

export type SkillCategory =
  | 'foundation'
  | 'isolation'
  | 'travel'
  | 'combo'
  | 'vocabulary'
  | 'routine';

export interface SkillNode {
  id: string;                              // snake_case unique id
  name: string;                            // human readable
  layer: 1 | 2 | 3 | 4 | 5 | 6;
  category: SkillCategory;
  description: string;
  prerequisites: string[];                 // ids of prerequisite nodes
  measurable_success_criterion: string;    // geometric rule using joint landmarks
  drill_description: string;
  drill_duration_seconds: number;
  mastery_threshold: string;
  common_mistakes: string[];
  sources: string[];
}

export interface RoutineNode extends SkillNode {
  layer: 6;
  category: 'routine';
  bpm: number;
  duration_seconds: number;
  required_skills: string[];               // ordered, from layers 1-5
  skill_weights: Record<string, number>;   // node_id -> weight 0-1
}

export type KnowledgeGraph = {
  nodes: (SkillNode | RoutineNode)[];
  version: string;
  generated_at: string;
};
```

Write a Zod schema in `lib/graph/loader.ts` that validates this exact shape and throws clearly if the real graph has any deviation tomorrow.

---

## Stub knowledge graph (use this as `public/data/knowledge_graph.json` tonight)

Create a minimal stub graph with ~8 nodes (2 foundations, 2 isolations, 1 travel, 1 combo, 1 vocabulary, 1 routine) so the UI has real data to render. Use plausible placeholder names. Mark every node with `"sources": ["STUB - replace with real graph"]` so it is unmistakable that these are placeholders. This stub must be DELETED tomorrow when the real graph drops in.

Stub example for one node:

```json
{
  "id": "stub_chest_isolation",
  "name": "Chest isolation",
  "layer": 2,
  "category": "isolation",
  "description": "STUB placeholder for chest isolation skill.",
  "prerequisites": ["stub_posture"],
  "measurable_success_criterion": "STUB - chest landmark moves >0.04m forward of root while shoulders stay within 0.02m baseline",
  "drill_description": "STUB drill",
  "drill_duration_seconds": 60,
  "mastery_threshold": "80% across 3 attempts",
  "common_mistakes": ["STUB"],
  "sources": ["STUB - replace with real graph"]
}
```

---

## Core modules in detail

### 1. Pose extraction (`lib/pose/poseExtractor.ts`)

Wrap MediaPipe Pose Landmarker. Expose a single class `PoseExtractor` with methods:
- `async init(): Promise<void>` — load the WASM and model files from CDN
- `detectFromVideo(video: HTMLVideoElement, timestampMs: number): PoseResult | null`
- `detectFromImage(image: HTMLImageElement): PoseResult | null`

`PoseResult` should contain the 33 landmarks (x, y, z, visibility) in both normalized image coords AND world coords.

Use the live-stream running mode for camera and video running mode for reference clips.

### 2. Joint angles (`lib/pose/jointAngles.ts`)

Convert 33 raw landmarks into a fixed-length vector of joint angles. Compute at minimum:
- Left and right elbow angle (shoulder-elbow-wrist)
- Left and right shoulder angle (hip-shoulder-elbow)
- Left and right hip angle (shoulder-hip-knee)
- Left and right knee angle (hip-knee-ankle)
- Torso lean (vertical reference to spine midline)
- Hip rotation around y-axis
- Chest forward displacement (z-distance from chest landmark to hip midpoint)

Return as a typed `JointAngleVector` (a Record<JointName, number> or a fixed-length array — pick whichever serializes cleaner).

This module must be pure TypeScript with NO browser dependencies. It will be ported to Swift.

### 3. DTW (`lib/scoring/dtw.ts`)

Implement FastDTW for sequence alignment of two arrays of `JointAngleVector`. Reference the standard algorithm — do not invent. The function signature:

```typescript
export function dtw(
  user: JointAngleVector[],
  reference: JointAngleVector[],
  windowSize?: number
): {
  cost: number;
  path: Array<[number, number]>; // (userIdx, refIdx) pairs
};
```

Use a constraint window (Sakoe-Chiba band) of ~10% of sequence length to keep it real-time. Use Euclidean distance over the joint-angle vector as the local cost.

### 4. Scoring (`lib/scoring/scorer.ts`)

Given DTW-aligned frame pairs, compute a 0-100 score per beat using:

```
similarity = cosineSimilarity(userVector, refVector)  // 0 to 1
frame_score = 100 * exp(-(1 - similarity) * 5)        // exponential decay, gentle
```

Then aggregate frame_scores per beat (group frames by which beat they fall into using the beat tracker output), and aggregate beat_scores into a final dance score.

Also expose a `correctionHint(frame)` function that returns a human-readable hint when a specific joint deviates significantly: e.g. "left elbow lower" or "you are a beat behind."

### 5. Beat tracker (`lib/scoring/beatTracker.ts`)

Use Web Audio API (`AudioContext`, `AnalyserNode`) to do real-time onset detection on the reference dance audio. For v1, allow a hardcoded BPM per reference dance fixture (the trending TikTok dances have known BPMs). The beat tracker should:
- Take a BPM and an audio start timestamp
- Emit beat events synchronously with audio playback
- Provide a function `getCurrentBeat(audioCurrentTime: number): number`

### 6. Recommender (`lib/graph/recommender.ts`)

Given a `KnowledgeGraph` and a `MasteryStore`, pick the next drill after a dance attempt:
- For the dance just attempted, identify the lowest-mastery `required_skills`
- Weight by `skill_weights` from the routine node
- Return the top 1 skill to drill, along with the routine's drill_description

### 7. Readiness (`lib/graph/readiness.ts`)

For each routine node, compute a `% ready` integer 0-100:
- For each required skill, get current mastery from the store (0-1)
- Weighted average using `skill_weights`
- Return rounded int

This drives the "% ready" badge on each dance card on the home screen.

### 8. Mastery store (`lib/mastery/store.ts`)

localStorage-backed. API:
- `recordAttempt(danceId, perSkillScores: Record<skillId, score>)`
- `getMastery(skillId): number` (0-1, EMA over recent attempts)
- `getAllMastery(): Record<skillId, number>`
- `exportAsJSON()` / `importFromJSON()` for debugging

Use exponential moving average with alpha=0.4 so recent attempts weight more than old ones.

---

## UI screens to build

Match the iPhone-format mockups. Dark mode. Mobile-first (max-width 430px container).

### Home screen (`app/page.tsx`)

- Top: greeting + streak counter (placeholder streak = 7)
- Search bar that says "paste a tiktok or search" (non-functional, just visual)
- Featured dance card (trending) with gradient bg
- "For You" section with 3-5 dance cards, each showing % ready badge
- Bottom nav: Home (active), Trophy, Stats, Profile

### Practice screen (`app/practice/[danceId]/page.tsx`)

- Top: progress bar showing beat position in dance, X button to exit
- Center: full-bleed camera view with skeleton overlay drawn on canvas
- Top-right of camera: small picture-in-picture reference video
- Top-left of camera: correction toast (e.g. "left elbow higher") when scoring detects a deviation > threshold
- Bottom of camera: small LIVE indicator pill
- Below camera: big sync score number (0-100, updates per beat), delta vs last attempt
- Bottom: rewind, pause/play, skip buttons

Camera permission flow: request on screen load, show graceful error state if denied.

### Results screen (`app/results/[sessionId]/page.tsx`)

- Title: "Run complete" + dance name + attempt number
- Big score (60+px font), color-coded (green >80, amber 60-80, red <60)
- Score delta from last attempt
- Per-skill breakdown: skill name + score bar (use the same color coding)
- "Next up" card showing the auto-recommended drill
- Big white "Drill it" CTA button → routes to `app/drill/[skillId]/page.tsx`

### Drill screen (`app/drill/[skillId]/page.tsx`)

- Top: skill name + back button
- Description of the skill
- Embedded reference clip (use a placeholder gif/video)
- Live camera with skeleton overlay
- Countdown timer for drill_duration_seconds
- Final score for the drill → updates mastery, kicks back to results or home

### Phone frame for development (`components/PhoneFrame.tsx`)

When viewing on desktop (viewport > 600px), wrap content in an iPhone-shaped frame so you can see the mobile design clearly during dev. On actual mobile, full-screen.

---

## Reference dance fixtures (`lib/dances/fixtures.ts`)

Hardcode 3 reference dances for the prototype. Use these IDs so they match the stub graph:

```typescript
[
  {
    id: 'fixture_apt',
    name: 'Apt. challenge',
    artist: 'Rosé',
    duration_seconds: 28,
    bpm: 149,
    video_url: '/data/reference_dances/apt.mp4',
    required_skills: ['stub_body_roll', 'stub_two_step', 'stub_shoulder_iso', 'stub_arm_wave']
  },
  {
    id: 'fixture_espresso',
    name: 'Espresso',
    artist: 'Sabrina Carpenter',
    duration_seconds: 22,
    bpm: 103,
    video_url: '/data/reference_dances/espresso.mp4',
    required_skills: ['stub_two_step', 'stub_shoulder_iso']
  },
  {
    id: 'fixture_renegade',
    name: 'Renegade',
    artist: 'K Camp',
    duration_seconds: 18,
    bpm: 126,
    video_url: '/data/reference_dances/renegade.mp4',
    required_skills: ['stub_arm_wave', 'stub_body_roll', 'stub_shoulder_iso']
  }
]
```

For the video files: do not download real TikTok videos (copyright risk). Generate or use placeholder mp4 files — even a 5-second loop of a colored rectangle is fine. Tomorrow Jaiyen will swap in real footage.

---

## Build order

Do this exactly in this order. Commit after each step (use `git commit -m "step N: ..."`).

1. Init Next.js + TypeScript + Tailwind. Set up `app/layout.tsx` with dark mode + viewport meta + 430px max-width container + iPhone frame for desktop.
2. Write all type definitions in `lib/*/types.ts` files. No logic yet, just types.
3. Write the stub knowledge_graph.json with 8 nodes covering all 6 layers.
4. Write the Zod validator in `lib/graph/loader.ts`. Test that it accepts the stub.
5. Write `lib/dances/fixtures.ts` with the 3 reference dances above.
6. Write `lib/mastery/store.ts` with localStorage persistence. Unit test if time permits.
7. Write `lib/graph/readiness.ts` and `lib/graph/recommender.ts` against the stub graph.
8. Build the Home screen UI matching the mockup. Wire to fixtures + readiness computation.
9. Write `lib/pose/poseExtractor.ts` and verify MediaPipe loads in browser. Test that landmarks come through on a still image.
10. Write `lib/pose/jointAngles.ts`. Unit test with synthetic landmarks (e.g. a T-pose should produce specific known angles).
11. Write `lib/scoring/dtw.ts` and `lib/scoring/similarity.ts`. Unit test with two identical sequences (cost should be 0) and one shifted sequence (cost should be small).
12. Write `lib/scoring/scorer.ts` end-to-end.
13. Write `lib/scoring/beatTracker.ts` with hardcoded BPM support.
14. Build the Practice screen UI. Wire up camera, pose extraction, skeleton overlay, live score.
15. Build the Results screen UI. Wire to per-skill scores + recommender.
16. Build the Drill screen UI. Wire to mastery store updates.
17. Polish: error states, loading states, camera permission denied state, responsive design check.
18. Write `README.md` with setup instructions and the SPECIFIC instructions on how to swap in the real knowledge graph tomorrow.
19. Verify `npm run build` succeeds. Verify the dev server runs without errors.
20. Write a final `OVERNIGHT_SUMMARY.md` listing what works, what's stubbed, what blockers were hit, and exactly what Jaiyen needs to do tomorrow morning.

---

## Hard rules

1. **DO NOT invent dance pedagogy.** The stub graph is the only skill content you create. The real graph is coming tomorrow.
2. **DO NOT hardcode the skill tree in any UI component.** Everything reads from the graph via the loader.
3. **DO NOT download real TikTok videos.** Use placeholder media.
4. **DO NOT use external paid APIs or services.** Everything must run locally / on free tier.
5. **DO NOT skip the type definitions step.** Types come first, implementation follows.
6. **DO NOT commit broken builds.** If a step fails, write to BLOCKERS.md and move to the next decoupled step.
7. **Use `git commit` after each numbered step** so Jaiyen can review your work step-by-step in the morning.

---

## What Jaiyen will do tomorrow morning (write this in README.md)

1. Paste the real `knowledge_graph.json` from Claude Research into `public/data/knowledge_graph.json`, replacing the stub.
2. The Zod validator runs on app load and will throw clearly if the schema doesn't match — fix any schema deviations.
3. Update `lib/dances/fixtures.ts` so `required_skills` arrays reference real graph node IDs instead of `stub_*` IDs.
4. Add real reference dance videos to `public/data/reference_dances/`.
5. `npm run dev` and test the full loop: pick a dance → practice → score → drill → see mastery update.
6. Deploy to Vercel: `vercel --prod`.

---

## Final deliverable

A working Next.js web prototype where:
- Home screen shows 3 dances with % ready badges computed from the stub graph
- Practice screen turns on the camera, runs pose detection, shows skeleton overlay, and displays a live (placeholder) score
- Results screen shows per-skill breakdown
- Drill screen runs a timed drill and updates mastery
- All code is portable to Swift (pure-TS modules in `lib/pose/`, `lib/scoring/`, `lib/graph/`, `lib/mastery/` have zero DOM dependencies)
- Swapping the stub graph for the real graph tomorrow is a one-line file replacement
- DECISIONS.md, BLOCKERS.md, and OVERNIGHT_SUMMARY.md are all written