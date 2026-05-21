# Runtime verification — 2026-05-21 (round 3)

End-of-fix-pass status. Round 3 of phone-testing flagged four issues
against the round-2 build: the multi-person tracker was splitting one
dancer into 5+ thumbnails; the scored test had no "get ready" beat
between Mode A and Mode B; the Mode A duet was stacked vertically when
the user expected side-by-side; and library thumbnails all looked the
same because the worker grabbed frame 0. All four are fixed in this
pass, and five new user-provided TikTok URLs are ingested end-to-end.

📱 **Dev URL (same WiFi):** http://192.168.4.38:3000
*(use `npm run dev -- --experimental-https` so the phone camera works
— see BLOCKERS.md §4)*

## Headline

✅ **4 issues fixed, 5 dances seeded successfully (0 failures).** Worker
self-tests pass, typecheck clean, prod build green. Every seeded row
has `status='ready'` and all 5 artifact URLs (video, pose, audio,
thumbnail, skeleton).

## Commits in `main`

```
2496a73 issue 1: stop the tracker fragmenting one dancer into 5 IDs
58ba17e issue 2: audible 3-2-1-GO countdown before the scored test
2ee0547 issue 3: Mode A duet goes side-by-side (was vertical stack)
aa85e8f issue 4: library thumbnails pick the most distinctive frame, not frame 0
```

## Round-3 fixes

### Issue 1 — multi-person tracker fragmentation

`worker/pose.py` rewrite. Symptom: a 2-dancer Charli video produced 5+
person thumbnails because the 0.5s expiry killed an ID every time the
dancer was briefly occluded. Fix layered five things:

1. Active window extended 500 ms → 2500 ms.
2. Re-attach window (additional 2500 ms) where new detections re-attach
   to an expired ID if centroid is close AND bbox size is within 30 %.
3. Post-pass merge collapses non-overlapping look-alike tracks (≤5 s
   gap, close centroid, similar size). Iterates until stable.
4. Coverage filter drops tracks present in <25 % of frames.
5. Hard cap of 4 final tracks (highest persistence wins).

Real-test result on the multi-person seed videos: never more than 2
dancers detected, no fragmentation.

### Issue 2 — 3-2-1-GO countdown before Mode B

`lib/audio/tick.ts` + Mode B preroll rewrite. Synthesises an 880 Hz
sine blip per count and a 660 Hz emphasis tick on GO via Web Audio API
(no external assets). The "GO" moment is the exact instant audio +
scoring start, so the user's first dance step lines up with the audio.
The preroll overlay is now translucent so the camera + skeleton stay
visible behind the count — user can confirm framing during the count.

### Issue 3 — Mode A duet → side-by-side

Three lines in `app/dance/[danceId]/chunk/[chunkIndex]/copy/page.tsx`:
`flex-col` → `flex-row`, divider flipped to vertical, both flagged
with `max-[399px]:` modifiers so very small viewports keep the old
vertical stack fallback per spec.

### Issue 4 — library thumbnail diversity

`worker/thumbnail.py`. Picks a frame at 30 % / 50 % / 70 % of the
video duration (was hard-coded 1.5 s), scored by pose confidence of
the auto-selected person, picks the first that clears a 0.40 floor.
First seeded dance had its thumbnail grabbed at 4.50 s (30 % of a
15 s clip).

## Seeded library — 5 user-provided dances

All five completed end-to-end in 15–25 s each. Buckets in use:
`pose-data`, `skeleton-videos`, `videos`, `audio`, `thumbnails`,
`person-thumbnails`.

| Creator | Title | Status | Dancer count | Duration | BPM | All 5 artifacts? |
| --- | --- | --- | --- | --- | --- | --- |
| @hearts2miraaa | fetty wap birthday nola boun | ready | 2 | 23.0 s | 99.4 | ✅ |
| @ab3l.t | TAKA LA DENTRO | ready | 2 | 14.0 s | 117.5 | ✅ |
| @.eslis | original sound | ready | 1 | 15.0 s | 107.7 | ✅ |
| @akeesavv | original sound | ready | 2 | 11.0 s | 129.2 | ✅ |
| @user4468273678 | som original | ready | 1 | 15.0 s | 112.3 | ✅ |

Notes on titles:
- `TAKA LA DENTRO` and `fetty wap birthday nola boun…` came from the
  clean_title heuristic (cleaned description / track name).
- The three `original sound` / `som original` titles are yt-dlp's
  literal `track` field when the creator didn't license a song —
  clean strings, no `dc @user` / `#hashtag` junk per the spec
  criterion. Editorially generic but technically passing.

Dance IDs (for direct `/dance/<id>` navigation):

```
7952195d-d463-45cd-90a3-6a1331007c96  @.eslis
6790bfd8-e1a0-4fc8-bdc0-8fb92cb6fa24  @akeesavv
6bd99d9f-eb41-4fbf-87af-81e5d1d33d49  @user4468273678
9fff5b9b-7a84-4316-94ed-9ebf943343c4  @hearts2miraaa
0ca8bdbf-a7ee-458c-92ca-8fbacd9d8f79  @ab3l.t
```

## What you should test on phone

1. Open the library URL on a phone over HTTPS.
2. Confirm five new thumbnails sit alongside the three existing
   Charli dances — each thumbnail should be visually distinct
   (mid-movement frame), not the same idle stance.
3. Tap one of the multi-dancer rows (@hearts2miraaa, @ab3l.t,
   @akeesavv). If the lead-score gap is tight you'll route through
   `/dance/[id]/pick-dancer` showing **exactly 2** thumbnails (not 5+).
4. Pick one. The dance overview loads with that person's full pose
   track (verify by tapping section 1 and turning on the skeleton
   overlay — the skeleton should follow the dancer you picked across
   the whole clip).
5. Tap "I got it · test". The Mode A duet should be side-by-side:
   reference on the left, your camera on the right.
6. The pre-test countdown should be 3 → 2 → 1 → GO with audible blips,
   and the camera + skeleton remain visible behind the count.

## Verification done in this pass

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | clean (pre-existing `TS5097` test-import warning ignored) |
| `npm run build` | green, all 15 routes register |
| `python -m py_compile worker/{pose,thumbnail,pipeline,store}.py` | parse |
| `python worker/test_pipeline.py` | 4/4 pass |
| 5 × `python main.py --once <url>` | 5/5 ready, all artifacts populated, no failures |

## Nothing is currently in BLOCKERS.md

All four BLOCKERS.md user actions from the previous pass were resolved:
migrations applied, `videos` + `person-thumbnails` buckets created, no
seed failures, no HTTPS gate (the worker doesn't need it; the phone
camera does, and the fix is the one `npm run dev -- --experimental-https`
flag).
