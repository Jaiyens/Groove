# Blockers — user action required

None currently. Every item from the round-2 pass has been resolved
(migrations applied, storage buckets created, legacy rows re-processed)
and all 5 round-3 seed URLs ingested end-to-end with no failures — see
RUNTIME_VERIFICATION.md.

The only remaining standing setup item, kept here as a reminder:

## HTTPS on the dev server (camera access on phone)

Modern browsers block `getUserMedia` on plain HTTP origins except
localhost. To use the phone camera, run the dev server with:

```bash
npm run dev -- --experimental-https
```

Next prints something like `https://192.168.4.38:3001` — visit that URL
on the phone. First load shows a "not trusted" warning; tap through it
("Visit website" on iOS, "Advanced → Proceed" on Chrome).
