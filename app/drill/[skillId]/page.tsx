'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import FramingToast from '@/components/FramingToast';
import LiveScore from '@/components/LiveScore';
import ProgressBar from '@/components/ProgressBar';
import SkeletonOverlay from '@/components/SkeletonOverlay';
import { useGraph } from '@/lib/graph/context';
import { getMasteryStore } from '@/lib/mastery/store';
import { attachStream } from '@/lib/pose/cameraAttach';
import { isFramingCalibrated } from '@/lib/pose/framingCalibration';
import { computeJointAngles } from '@/lib/pose/jointAngles';
import { PoseExtractor } from '@/lib/pose/poseExtractor';
import type { PoseLandmark } from '@/lib/pose/types';
import { frameScoreFromSimilarity } from '@/lib/scoring/scorer';
import { cosineSimilarity } from '@/lib/scoring/similarity';
import { neutralReferenceFrame } from '@/lib/scoring/syntheticReference';
import { scoreColor } from '@/lib/scoring/types';
import type { SkillNode } from '@/lib/graph/types';

interface PageProps {
  params: { skillId: string };
}

type CamState = 'idle' | 'requesting' | 'granted' | 'needs_tap' | 'denied' | 'unavailable';
type RunState = 'preroll' | 'running' | 'finished';

const PREROLL_SECONDS = 3;
const DRILL_BPM = 100; // gentle for drills

// Early-pass: if the live score stays at-or-above this for this many
// milliseconds in a row, the drill auto-completes with a celebration
// instead of forcing the user to wait out the timer.
const PASS_SCORE = 85;
const PASS_HOLD_MS = 3000;

export default function DrillPage({ params }: PageProps) {
  const router = useRouter();
  const search = useSearchParams();
  const { graph, bumpMastery } = useGraph();
  const fromParam = search.get('from');
  // Three `from` shapes are supported, in priority order:
  //   `/something`       — literal return path (Skills tab uses /progress)
  //   `dance:<id>`       — results-carousel re-attempt flow
  //   raw attempt id     — legacy /results/[sessionId] path
  const returnTarget = useMemo(() => {
    if (!fromParam) {
      return { kind: 'home' as const, href: '/', label: 'Done' };
    }
    if (fromParam.startsWith('/')) {
      return {
        kind: 'returnPath' as const,
        href: fromParam,
        label: labelForReturnPath(fromParam),
      };
    }
    if (fromParam.startsWith('dance:')) {
      const danceId = fromParam.slice('dance:'.length);
      if (danceId) {
        return {
          kind: 'reAttempt' as const,
          href: `/dance/${danceId}/test`,
          label: 'Re-attempt the dance',
        };
      }
    }
    return {
      kind: 'legacyResults' as const,
      href: `/results/${fromParam}`,
      label: 'Back to run',
    };
  }, [fromParam]);

  const skill = graph?.nodes.find((n) => n.id === params.skillId);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const extractorRef = useRef<PoseExtractor | null>(null);
  const rafRef = useRef<number | null>(null);
  const startMsRef = useRef<number | null>(null);
  const accScoreRef = useRef<{ sum: number; n: number }>({ sum: 0, n: 0 });
  // Last frame's timestamp + how long the score has been at-or-above
  // PASS_SCORE in a row. Updated every rAF tick.
  const lastTickMsRef = useRef<number | null>(null);
  const consecutiveHighMsRef = useRef(0);
  const passedEarlyRef = useRef(false);

  const [camState, setCamState] = useState<CamState>('idle');
  const [runState, setRunState] = useState<RunState>('preroll');
  const [prerollLeft, setPrerollLeft] = useState(PREROLL_SECONDS);
  const [landmarks, setLandmarks] = useState<PoseLandmark[] | null>(null);
  const [liveScore, setLiveScore] = useState(0);
  const [progress, setProgress] = useState(0);
  const [holdProgress, setHoldProgress] = useState(0); // 0..1, how full the 3s hold is
  const [finalScore, setFinalScore] = useState<number | null>(null);
  const [passedEarly, setPassedEarly] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  const duration = skill?.drill_duration_seconds ?? 60;

  useEffect(() => {
    if (graph && !skill) router.replace('/');
  }, [graph, skill, router]);

  useEffect(() => {
    if (typeof window === 'undefined' || isFramingCalibrated()) return;
    const here = `/drill/${params.skillId}${fromParam ? `?from=${fromParam}` : ''}`;
    router.replace(`/onboarding/frame-check?return=${encodeURIComponent(here)}`);
  }, [params.skillId, fromParam, router]);

  const startCamera = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setCamState('unavailable');
      return;
    }
    setCamState('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false,
      });
      streamRef.current = stream;
      const v = videoRef.current;
      if (!v) {
        setCamState('needs_tap');
        return;
      }
      const playing = await attachStream(v, stream);
      setCamState(playing ? 'granted' : 'needs_tap');
    } catch {
      setCamState('denied');
    }
  }, []);

  const handleTapToStart = useCallback(async () => {
    const v = videoRef.current;
    const s = streamRef.current;
    if (!v || !s) {
      startCamera();
      return;
    }
    const playing = await attachStream(v, s);
    setCamState(playing ? 'granted' : 'needs_tap');
  }, [startCamera]);

  useEffect(() => {
    if (!isFramingCalibrated()) return;
    if (camState === 'idle' && skill) startCamera();
  }, [camState, startCamera, skill]);

  useEffect(() => {
    if (camState !== 'granted') return;
    let cancelled = false;
    const ex = new PoseExtractor();
    extractorRef.current = ex;
    ex.init().then(() => {
      if (cancelled) ex.close();
    });
    return () => {
      cancelled = true;
      ex.close();
      extractorRef.current = null;
    };
  }, [camState]);

  useEffect(() => {
    if (camState !== 'granted' || runState !== 'preroll') return;
    if (prerollLeft <= 0) {
      setRunState('running');
      startMsRef.current = performance.now();
      lastTickMsRef.current = performance.now();
      consecutiveHighMsRef.current = 0;
      passedEarlyRef.current = false;
      accScoreRef.current = { sum: 0, n: 0 };
      return;
    }
    const t = setTimeout(() => setPrerollLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [camState, runState, prerollLeft]);

  useEffect(() => {
    if (camState !== 'granted' || runState !== 'running' || !skill) return;
    const durationMs = duration * 1000;
    const loop = () => {
      const v = videoRef.current;
      const ex = extractorRef.current;
      const now = performance.now();
      const t0 = startMsRef.current ?? now;
      const sessionT = now - t0;
      const lastTick = lastTickMsRef.current ?? now;
      const dt = Math.max(0, now - lastTick);
      lastTickMsRef.current = now;
      setProgress(Math.min(1, sessionT / durationMs));
      setSecondsLeft(Math.max(0, Math.ceil((durationMs - sessionT) / 1000)));

      let scoredThisFrame = 0;
      let frameHadScore = false;
      if (v && ex?.ready && v.readyState >= 2) {
        const res = ex.detectFromVideo(v, sessionT);
        if (res) {
          setLandmarks(res.landmarks);
          if (res.worldLandmarks.length > 0) {
            const vec = computeJointAngles(res.worldLandmarks);
            const ref = neutralReferenceFrame(sessionT, DRILL_BPM);
            const sim = cosineSimilarity(vec, ref);
            const s = frameScoreFromSimilarity(Math.max(0, sim));
            accScoreRef.current.sum += s;
            accScoreRef.current.n += 1;
            scoredThisFrame = s;
            frameHadScore = true;
            setLiveScore((p) => p * 0.75 + s * 0.25);
          }
        } else {
          setLandmarks(null);
        }
      }

      // Track how long the live score has been at-or-above PASS_SCORE
      // continuously. Drop back to 0 the moment they go below. When
      // the hold reaches PASS_HOLD_MS, auto-complete the drill early
      // with a "passed" flag so the done state can celebrate.
      if (frameHadScore && scoredThisFrame >= PASS_SCORE) {
        consecutiveHighMsRef.current += dt;
      } else if (frameHadScore) {
        consecutiveHighMsRef.current = 0;
      }
      setHoldProgress(Math.min(1, consecutiveHighMsRef.current / PASS_HOLD_MS));

      if (
        !passedEarlyRef.current &&
        consecutiveHighMsRef.current >= PASS_HOLD_MS
      ) {
        passedEarlyRef.current = true;
        const acc = accScoreRef.current;
        const final = acc.n > 0 ? acc.sum / acc.n : scoredThisFrame;
        setFinalScore(final);
        setPassedEarly(true);
        setRunState('finished');
        return;
      }

      if (sessionT >= durationMs) {
        const acc = accScoreRef.current;
        const final = acc.n > 0 ? acc.sum / acc.n : 0;
        setFinalScore(final);
        setRunState('finished');
        return;
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [camState, runState, skill, duration]);

  // Persist mastery on finish — snapshot prior + post so the completion
  // screen can show the delta. Ref-guarded so StrictMode double-effect
  // doesn't double-record the same drill.
  const persistedRef = useRef(false);
  const [masteryStats, setMasteryStats] = useState<{
    prior: number;
    post: number;
  } | null>(null);
  useEffect(() => {
    if (runState !== 'finished' || finalScore === null || !skill) return;
    if (persistedRef.current) return;
    persistedRef.current = true;
    const store = getMasteryStore();
    const prior = store.getMastery(skill.id);
    store.recordAttempt(`drill:${skill.id}`, { [skill.id]: finalScore }, finalScore);
    const post = store.getMastery(skill.id);
    setMasteryStats({ prior, post });
    bumpMastery();
  }, [runState, finalScore, skill, bumpMastery]);

  // Reverse-prereq lookup: which skills list this drill's skill as a
  // prerequisite? Surfacing these makes the graph visible — the user
  // sees that drilling this directly unblocks downstream moves.
  const unlocks = useMemo<SkillNode[]>(() => {
    if (!graph || !skill) return [];
    return graph.nodes.filter(
      (n) => n.category !== 'routine' && n.prerequisites.includes(skill.id),
    );
  }, [graph, skill]);

  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    },
    [],
  );

  const colorClass = useMemo(() => {
    if (finalScore === null) return 'text-white';
    return scoreColor(finalScore).color;
  }, [finalScore]);

  if (!graph) {
    return (
      <main className="flex h-full items-center justify-center text-ink-muted">
        Loading…
      </main>
    );
  }
  if (!skill) return null;

  return (
    <main className="flex h-full w-full flex-col bg-black">
      <header className="safe-top flex items-center gap-3 px-4 pt-3 pb-3">
        <button
          type="button"
          onClick={() => {
            if (typeof window !== 'undefined' && window.history.length > 1) {
              router.back();
            } else {
              router.push(returnTarget.href);
            }
          }}
          aria-label="Back"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-bg-card text-white active:scale-95"
        >
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-widest text-text-muted">Drill</div>
          <div className="truncate text-base font-bold">{skill.name}</div>
        </div>
        <div className="text-sm font-bold tabular-nums text-text-muted">
          {secondsLeft !== null ? `${secondsLeft}s` : `${duration}s`}
        </div>
      </header>

      <div className="px-4 pb-3">
        <ProgressBar progress={progress} />
      </div>

      {runState !== 'finished' ? (
        <div className="relative flex-1 overflow-hidden bg-bg-card mx-4 rounded-2xl">
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className="absolute inset-0 h-full w-full object-cover [transform:scaleX(-1)]"
          />
          <SkeletonOverlay landmarks={landmarks} videoRef={videoRef} mirror staleAfterMs={400} />
          {runState === 'running' && <FramingToast landmarks={landmarks} />}
          {/* Live instructions while the drill is running — the
              user kept saying "I don't know what to do." The drill
              description sits in a low-opacity card at the top so
              they can read it without it covering the skeleton. */}
          {runState === 'running' && (
            <div className="pointer-events-none absolute left-3 right-3 top-3 z-20 rounded-2xl bg-black/65 px-3 py-2 text-white backdrop-blur-sm">
              <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-coral">
                what to do
              </div>
              <div className="mt-0.5 text-xs leading-snug">
                {skill.drill_description}
              </div>
            </div>
          )}
          {/* Hold-to-pass ring. Fills as the score sits above the
              PASS_SCORE threshold; resets the moment they dip below.
              Lets the user SEE when they're about to pass instead of
              the early-completion feeling random. */}
          {runState === 'running' && holdProgress > 0 && (
            <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-full bg-black/70 px-4 py-2 text-white backdrop-blur-sm">
              <div className="flex items-center gap-2">
                <svg width={16} height={16} viewBox="0 0 36 36" aria-hidden>
                  <circle cx="18" cy="18" r="14" fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="4" />
                  <circle
                    cx="18"
                    cy="18"
                    r="14"
                    fill="none"
                    stroke="#FF6B6B"
                    strokeWidth="4"
                    strokeLinecap="round"
                    strokeDasharray={`${holdProgress * 87.96} 87.96`}
                    transform="rotate(-90 18 18)"
                    style={{ transition: 'stroke-dasharray 120ms linear' }}
                  />
                </svg>
                <span className="text-[10px] font-bold uppercase tracking-[0.18em]">
                  hold {Math.ceil((1 - holdProgress) * 3)}s
                </span>
              </div>
            </div>
          )}
          {runState === 'preroll' && camState === 'granted' && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/70 px-6 text-center backdrop-blur-sm">
              <div className="text-text-muted text-xs uppercase tracking-widest">
                {skill.name}
              </div>
              <div className="mt-3 text-[100px] font-extrabold leading-none tabular-nums text-white">
                {prerollLeft}
              </div>
              <p className="mt-4 max-w-xs text-sm leading-snug text-white/85">
                {skill.drill_description}
              </p>
            </div>
          )}
          {camState !== 'granted' && (
            <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-black p-8 text-center">
              {camState === 'requesting' && (
                <>
                  <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/20 border-t-white" />
                  <div className="mt-4 text-text-muted">Requesting camera…</div>
                </>
              )}
              {camState === 'denied' && (
                <>
                  <div className="text-xl font-bold">Camera blocked</div>
                  <button
                    type="button"
                    onClick={startCamera}
                    className="mt-4 rounded-full bg-white px-5 py-2 text-black text-sm font-bold"
                  >
                    Try again
                  </button>
                </>
              )}
              {camState === 'needs_tap' && (
                <>
                  <div className="text-xl font-bold">Tap to start</div>
                  <p className="mt-2 text-text-muted text-xs max-w-xs">
                    Your phone blocked autoplay.
                  </p>
                  <button
                    type="button"
                    onClick={handleTapToStart}
                    className="mt-4 rounded-full bg-white px-5 py-2 text-black text-sm font-bold"
                  >
                    Start
                  </button>
                </>
              )}
              {camState === 'unavailable' && (
                <>
                  <div className="text-xl font-bold">No camera</div>
                  <p className="mt-2 text-text-muted text-xs max-w-xs">
                    This browser doesn&apos;t expose getUserMedia.
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center overflow-y-auto px-6 py-6 text-center">
          {passedEarly ? (
            <>
              <div className="text-[10px] uppercase tracking-[0.22em] text-coral">
                drill passed
              </div>
              <div className="mt-2 text-3xl font-extrabold uppercase tracking-[0.12em] text-white">
                congratulations 🎉
              </div>
            </>
          ) : (
            <>
              <div className="text-[10px] uppercase tracking-[0.22em] text-text-muted">
                drill complete
              </div>
              <div className={`mt-3 text-[80px] font-extrabold tabular-nums leading-none ${colorClass}`}>
                {Math.round(finalScore ?? 0)}
              </div>
              <div className="mt-1 text-xs uppercase tracking-[0.18em] text-text-muted">
                nice work
              </div>
            </>
          )}

          <div className="mt-6 text-sm text-white/90">
            <span className="text-white font-semibold">{skill.name}</span>
          </div>

          {masteryStats && (
            <MasteryDelta prior={masteryStats.prior} post={masteryStats.post} />
          )}

          {unlocks.length > 0 ? (
            <div className="mt-6 w-full max-w-xs">
              <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-text-muted">
                this unlocks
              </div>
              <ul className="mt-2 space-y-1.5">
                {unlocks.slice(0, 3).map((u) => (
                  <li
                    key={u.id}
                    className="flex items-center justify-between gap-2 rounded-2xl bg-white/5 px-3 py-2 text-left text-sm text-white/90 ring-1 ring-white/10"
                  >
                    <span className="truncate">{u.name.toLowerCase()}</span>
                    <span className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-white/45">
                      {u.category}
                    </span>
                  </li>
                ))}
                {unlocks.length > 3 && (
                  <li className="text-[11px] text-white/55">
                    + {unlocks.length - 3} more
                  </li>
                )}
              </ul>
            </div>
          ) : (
            <p className="mt-6 max-w-xs text-xs leading-snug text-white/55">
              foundational skill — keep this rock solid; other moves
              build on it.
            </p>
          )}
        </div>
      )}

      <div className="safe-bottom px-4 pt-3 pb-4 bg-black">
        {runState !== 'finished' ? (
          <div className="mb-3 flex items-end justify-between">
            <LiveScore score={liveScore} label="effort" />
            <div className="text-right max-w-[160px]">
              <div className="text-[10px] uppercase tracking-widest text-text-muted">Focus</div>
              <div className="text-xs text-text-muted line-clamp-2">{skill.description}</div>
            </div>
          </div>
        ) : (
          // All exits go through router.push so the click never gets
          // eaten on iOS (the link version had this problem).
          //
          // Three paths depending on how the user arrived:
          //   from=dance:X    — re-attempt → see your skills → home
          //   from=/progress  — back to your moves → home (no
          //                      'see your skills', it's the same view)
          //   no from         — see your skills → home
          //
          // The Skills tab is surfaced everywhere it isn't redundant so
          // drilling never feels like a dead-end.
          <DrillExitButtons
            primaryHref={returnTarget.href}
            primaryLabel={returnTarget.label}
            showSkillsTab={returnTarget.href !== '/progress' && returnTarget.kind !== 'returnPath'}
            onNav={(href) => router.push(href)}
          />
        )}
      </div>
    </main>
  );
}

// Compact progress bar with prior → post percent labels. Animates from
// prior to post on mount so the bump reads as a delta, not a number.
function MasteryDelta({ prior, post }: { prior: number; post: number }) {
  const priorPct = Math.round(Math.max(0, Math.min(1, prior)) * 100);
  const postPct = Math.round(Math.max(0, Math.min(1, post)) * 100);
  const delta = postPct - priorPct;
  const [animated, setAnimated] = useState(priorPct);
  useEffect(() => {
    const start = performance.now();
    const DURATION = 900;
    let raf = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, (now - start) / DURATION);
      const eased = 1 - Math.pow(1 - t, 3);
      setAnimated(Math.round(priorPct + (postPct - priorPct) * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [priorPct, postPct]);
  return (
    <div className="mt-5 w-full max-w-xs">
      <div className="flex items-baseline justify-between text-[10px] uppercase tracking-[0.18em] text-text-muted">
        <span>mastery</span>
        <span className="font-semibold text-white tabular-nums">
          {animated}%
          {delta > 0 && (
            <span className="ml-2 text-accent-green">+{delta}</span>
          )}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-gradient-to-r from-coral via-coral to-accent-green transition-all duration-700"
          style={{ width: `${animated}%` }}
          aria-hidden
        />
      </div>
    </div>
  );
}

function DrillExitButtons({
  primaryHref,
  primaryLabel,
  showSkillsTab,
  onNav,
}: {
  primaryHref: string;
  primaryLabel: string;
  showSkillsTab: boolean;
  onNav: (href: string) => void;
}) {
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => onNav(primaryHref)}
        className="block w-full rounded-full bg-white py-4 text-center text-base font-bold text-black active:scale-[0.99]"
      >
        {primaryLabel}
      </button>
      {showSkillsTab && (
        <button
          type="button"
          onClick={() => onNav('/progress')}
          className="block w-full rounded-full bg-white/12 py-3 text-center text-sm font-bold uppercase tracking-[0.18em] text-white ring-1 ring-white/20 active:scale-[0.99]"
        >
          See your skills
        </button>
      )}
      <button
        type="button"
        onClick={() => onNav('/')}
        className="block w-full rounded-full bg-white/5 py-3 text-center text-sm font-bold uppercase tracking-[0.18em] text-white/70 ring-1 ring-white/10 active:scale-[0.99]"
      >
        Home
      </button>
    </div>
  );
}

function labelForReturnPath(path: string): string {
  if (path === '/' || path === '') return 'Home';
  // Use the leaf segment so /progress → "back to progress", etc.
  const seg = path.replace(/\/+$/, '').split('/').pop() ?? '';
  if (!seg) return 'Back';
  const friendly = seg === 'progress' ? 'your moves' : seg.replace(/-/g, ' ');
  return `Back to ${friendly}`;
}
