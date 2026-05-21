> ⚠️ **READ FIRST — overnight 2026-05-21**
>
> Fix 1 (BoT-SORT) is implemented and committed (6bb8f83). The
> mandatory acceptance test in SPECK.md §Fix 1 says: "Run on the
> existing @hearts2miraaa 2-dancer video. The pick-a-dancer screen
> should show **exactly 2** thumbnails, not 3-4."
>
> **BoT-SORT produced exactly 3 tracks** because the video actually
> has 3 dancers — not 2. The premise of the acceptance test is wrong.
> Per SPECK hard rule §4 I stopped before starting Fix 2 and wrote this
> note. Details + image proof below. Pick a path forward, ping me, and
> I'll continue.

# Blockers — user action required

## 1. @hearts2miraaa acceptance test premise is wrong (3 dancers, not 2)

### What I observed

Ran the new BoT-SORT pipeline on the existing video at
`https://qzrnkvbbthrxjhigcxfk.supabase.co/storage/v1/object/public/videos/9fff5b9b-7a84-4316-94ed-9ebf943343c4/video.mp4`
(dance id `9fff5b9b-7a84-4316-94ed-9ebf943343c4`):

```
pose: 703 frames, 3 person(s), top=p2 lead=0.86, pick=False, low_quality=False

  p2: lead=0.858  persistence=0.926  centrality=0.919  size=0.748  ← blonde, center
  p1: lead=0.612  persistence=0.872  centrality=0.362  size=0.450  ← brunette, left
  p3: lead=0.599  persistence=0.905  centrality=0.337  size=0.429  ← brunette, right
```

All three IDs appear in **613 of 703 frames (87%) simultaneously** —
this is not fragmentation, they are three distinct people standing in
the shot at the same time.

### Visual proof

See [`docs/blocker_evidence/hearts2miraaa_three_dancers.jpg`](docs/blocker_evidence/hearts2miraaa_three_dancers.jpg)
— mid-clip frame with all 3 tracker bboxes drawn. Three different
dancers (brunette in black on the left, blonde in white in the center,
brunette in white+grey on the right).

[`docs/blocker_evidence/hearts2miraaa_coexistence.jpg`](docs/blocker_evidence/hearts2miraaa_coexistence.jpg)
shows the same trio at t≈33 ms (different camera framing — all three
are still present in-frame).

### Why round-3 said "2 dancers"

The centroid tracker had a coverage filter (drop tracks <25% of frames)
and a final cap (max 4 tracks). With heavy fragmentation, one of the
real dancers' detections must have split across enough sub-IDs that
none individually cleared the 25% floor — net result, that dancer was
silently dropped and we shipped a "2-dancer" reading. BoT-SORT doesn't
fragment, so the third dancer now survives the filter.

### Why I didn't tune to force the count down to 2

There is no honest threshold that drops one of these three. All have
80%+ persistence, plausible centrality and size, and clearly visible
human poses. The only way to land on 2 is to either:
- raise `MIN_TEMPORAL_COVERAGE` past ~88% (would also drop one real
  dancer from many other clips); or
- introduce an off-center penalty severe enough to kill the side
  dancers (would mis-identify the lead in any clip where two dancers
  are framed symmetrically).

Either is worse than reporting the truth.

### Action — pick one, then ping me

1. **Accept 3 as correct.** Update the SPECK acceptance test to
   "exactly 3 thumbnails for @hearts2miraaa". I'll resume at Fix 2.
2. **Use a different acceptance video.** Tell me a known 2-dancer
   TikTok URL (the @ab3l.t and @akeesavv seeds were both labelled
   `dancer_count=2` by the old tracker — pick whichever you trust).
   I'll re-run the acceptance there before continuing.
3. **Defer / disagree.** If you want me to push on regardless of
   what's in the video, say so explicitly and I'll move to Fix 2 on
   the strength of "BoT-SORT detects ground truth" alone.

The committed Fix 1 code is safe to ship as-is for everything except
the literal "exactly 2" criterion — the tracker is correctly
identifying the actual content of the video.

---

## 2. (standing) HTTPS on the dev server (camera access on phone)

Modern browsers block `getUserMedia` on plain HTTP origins except
localhost. To use the phone camera, run the dev server with:

```bash
npm run dev -- --experimental-https
```

Next prints something like `https://192.168.4.38:3001` — visit that URL
on the phone. First load shows a "not trusted" warning; tap through it
("Visit website" on iOS, "Advanced → Proceed" on Chrome).
