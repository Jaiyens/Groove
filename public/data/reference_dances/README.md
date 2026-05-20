# Reference dance videos

Placeholder directory. Real chorus clips arrive from Jaiyen.

Expected files (referenced by `lib/dances/fixtures.ts` and merged with the
corresponding Layer 6 routine node in `public/data/knowledge_graph.json`):

- `golden.mp4` — `routine_golden` — Golden by HUNTR/X (~16s, 123 BPM)
- `dead_dance.mp4` — `routine_dead_dance` — The Dead Dance by Lady Gaga (~20s, 124 BPM)
- `not_cute_anymore.mp4` — `routine_not_cute_anymore` — Not Cute Anymore by ILLIT (~15s, 99 BPM)

The reference video component gracefully degrades to a "no video / placeholder"
panel when these are absent, so the rest of the practice loop is still demoable
without the real footage. Audio for Mode B / C is sourced from the same mp4
files — once these are dropped in, the audio track plays automatically.

**Do not download real TikTok videos directly** — use original recordings or
licensed footage. Spec hard rule #3.
