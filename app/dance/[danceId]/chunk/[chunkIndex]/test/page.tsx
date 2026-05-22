'use client';

// Mode B — scored chunk test.
//
// Camera goes full-screen. Reference video unmounted. Reference dance audio
// plays so the user has the beat. Skeleton overlay on. DTW scores the user
// against the synthetic reference for [chunk.startMs, chunk.endMs].
// On finish: score popup. If >= PASS_THRESHOLD → unlock next chunk and offer
// next-chunk CTA; else offer try-again / back-to-copy.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import BackHomeButton from '@/components/BackHomeButton';
import CorrectionToast from '@/components/CorrectionToast';
import DualSkeletonOverlay from '@/components/DualSkeletonOverlay';
import FramingToast from '@/components/FramingToast';
import ResultsCard from '@/components/ResultsCard';
import SkeletonOverlay from '@/components/SkeletonOverlay';
import StartOverlay from '@/components/StartOverlay';
import VolumeControl from '@/components/VolumeControl';
import { useDanceAudio } from '@/lib/audio/danceAudio';
import { useDance } from '@/lib/dances/useDance';
import { recordChunkScore } from '@/lib/mastery/chunkProgress';
import { recordContinueLearning } from '@/lib/mastery/continueLearning';
import { attachStream } from '@/lib/pose/cameraAttach';
import { isFramingCalibrated } from '@/lib/pose/framingCalibration';
import { compute2DJointAngles } from '@/lib/pose/jointAngles';
import { mirrorLandmarksHorizontal } from '@/lib/pose/normalize';
import { PoseExtractor } from '@/lib/pose/poseExtractor';
import { landmarkAt, useReferencePose } from '@/lib/pose/referencePose';
import type { FrameSample, LandmarkFrame, PoseLandmark } from '@/lib/pose/types';
import { BeatTracker } from '@/lib/scoring/beatTracker';
import {
  buildReferenceLandmarkSequence,
  buildReferenceSequence,
  hasRealReferenceFrames,
  referenceFrameAt,
} from '@/lib/scoring/referenceFrames';
import {
  correctionHint,
  frameScoreFromSimilarity,
  scoreSession,
} from '@/lib/scoring/scorer';
import { cosineSimilarity } from '@/lib/scoring/similarity';
import {
  generateReferenceSequence,
  neutralReferenceFrame,
} from '@/lib/scoring/syntheticReference';
import type { CorrectionHint, SessionScore } from '@/lib/scoring/types';
import {
  isDualOverlayEnabled,
  setDualOverlayEnabled,
} from '@/lib/scoring/uiPrefs';

type CamState = 'idle' | 'requesting' | 'granted' | 'needs_tap' | 'denied' | 'unavailable';
// SPECK round-4 §Fix 2: scoring does not auto-start after camera grants.
// `ready` shows the StartOverlay; tapping start kicks the overlay's own
// 3-2-1-GO countdown, and onGo flips state to `running`.
type RunState = 'waiting_for_camera' | 'ready' | 'running' | 'finished';

interface PageProps {
  params: { danceId: string; chunkIndex: string };
}

export default function TestPage({ params }: PageProps) {
  const router = useRouter();
  const chunkIndex = Number(params.chunkIndex);
  const { loading, notFound, dance, chunks } = useDance(params.danceId);
  const chunk = chunks[chunkIndex];

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const extractorRef = useRef<PoseExtractor | null>(null);
  const rafRef = useRef<number | null>(null);
  const userFramesRef = useRef<FrameSample[]>([]);
  // Stage 4: parallel landmark-frame collection so the scorer can run
  // the canonical-angle pipeline. The legacy vector-frame collection
  // above is kept so the live readout's cosineSimilarity (which still
  // wants a single-frame angle vector) keeps working without an
  // architectural change.
  const userLandmarkFramesRef = useRef<LandmarkFrame[]>([]);
  const startMsRef = useRef<number | null>(null);
  const lastHintAtRef = useRef<number>(0);
  const lastDetectAtRef = useRef<number>(0);

  const [camState, setCamState] = useState<CamState>('idle');
  const [runState, setRunState] = useState<RunState>('waiting_for_camera');
  const [landmarks, setLandmarks] = useState<PoseLandmark[] | null>(null);
  // User landmarks AFTER the chokepoint mirror (lib/pose/normalize.ts
  // convention). Fed to DualSkeletonOverlay so the visual partner
  // shows the user's body in the same frame the scorer scores.
  const [userMirroredLandmarks, setUserMirroredLandmarks] = useState<PoseLandmark[] | null>(null);
  const [refLandmarks, setRefLandmarks] = useState<PoseLandmark[] | null>(null);
  const [liveScore, setLiveScore] = useState(0);
  const [progress, setProgress] = useState(0);
  const [hint, setHint] = useState<CorrectionHint | null>(null);
  const [poseStatus, setPoseStatus] = useState<'ok' | 'lost' | 'failed'>('ok');
  const [finalScore, setFinalScore] = useState<number | null>(null);
  const [sessionScore, setSessionScore] = useState<SessionScore | null>(null);
  const [unlockedNext, setUnlockedNext] = useState(false);
  const [volume, setVolume] = useState(1);
  const [showDual, setShowDual] = useState<boolean>(() => isDualOverlayEnabled());

  const audio = useDanceAudio(dance?.audio_url ?? null, {
    initialVolume: volume,
    loop: false,
  });

  // Real reference pose data (worker-extracted joint frames). When
  // present, both the dual-skeleton overlay and the scoring math use
  // these landmarks instead of the synthetic neutral-pose placeholder.
  // The hook caches per-URL via lib/pose/referencePose.ts so re-mounts
  // don't re-fetch.
  const { data: poseData } = useReferencePose(dance?.pose_data_url ?? null);
  const hasRealReference = hasRealReferenceFrames(poseData);

  // spec.md §Mode-B-hang fix: framing gate removed. The standback
  // callout on the dance setup screen already covers user education;
  // no in-app gate is needed in Mode B. We still log what
  // isFramingCalibrated() WOULD have returned so prod tests can
  // confirm the state of the localStorage flag on the test device.
  useEffect(() => {
    const calibrated =
      typeof window === 'undefined' ? null : isFramingCalibrated();
    // eslint-disable-next-line no-console
    console.log('[mode-b] mount', {
      danceId: params.danceId,
      chunkIndex,
      framingCalibrated: calibrated,
      ua: typeof navigator !== 'undefined' ? navigator.userAgent : null,
    });
  }, [params.danceId, chunkIndex]);

  useEffect(() => {
    if (!dance || !chunk || chunks.length === 0) return;
    recordContinueLearning({
      danceId: dance.id,
      title: dance.name,
      displayName: dance.name,
      creatorHandle: dance.artist,
      thumbnailUrl: dance.thumbnail_url,
      totalChunks: chunks.length,
      currentChunkIndex: chunkIndex,
    });
  }, [dance, chunk, chunks.length, chunkIndex]);

  // Mirror volume changes into the audio element.
  //
  // spec.md §Mode-B-hang fix: deps intentionally do NOT include
  // `audio`. The hook returns a fresh outer object literal every
  // render (since useDanceAudio's internal state changes on
  // timeupdate / play / pause events) — depending on that reference
  // caused this effect to fire every render, and since setVolume
  // calls setState which always produces a new state object, every
  // call further changed the `audio` reference, creating an
  // infinite re-render loop that manifested as a Mode B hang.
  // setVolume is wrapped in useCallback([]) so the closure capture
  // is stable; we only need to re-fire when `volume` itself
  // changes. The architectural alternative (memoizing the hook's
  // return value) requires splitting state from controller — a
  // larger API change that would touch Mode C. Picking the
  // single-line consumer fix keeps the blast radius to this file.
  useEffect(() => {
    audio.setVolume(volume);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume]);

  // Camera.
  const startCamera = useCallback(async () => {
    // eslint-disable-next-line no-console
    console.log('[mode-b] startCamera() invoked');
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      // eslint-disable-next-line no-console
      console.log('[mode-b] camera unavailable: no mediaDevices.getUserMedia');
      setCamState('unavailable');
      return;
    }
    setCamState('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false,
      });
      // eslint-disable-next-line no-console
      console.log('[mode-b] getUserMedia resolved', {
        tracks: stream.getVideoTracks().map((t) => t.label),
      });
      streamRef.current = stream;
      const v = videoRef.current;
      if (!v) {
        // eslint-disable-next-line no-console
        console.log('[mode-b] videoRef missing at attach, → needs_tap');
        setCamState('needs_tap');
        return;
      }
      const playing = await attachStream(v, stream);
      // eslint-disable-next-line no-console
      console.log('[mode-b] attachStream resolved', { playing });
      setCamState(playing ? 'granted' : 'needs_tap');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log('[mode-b] getUserMedia rejected', err);
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
    // eslint-disable-next-line no-console
    console.log('[mode-b] handleTapToStart attachStream', { playing });
    setCamState(playing ? 'granted' : 'needs_tap');
  }, [startCamera]);

  // spec.md §Mode-B-hang fix: framing gate removed from camera
  // bootstrap so the camera request fires on every entry, not just
  // for users who happen to have the calibrated-localStorage flag.
  useEffect(() => {
    if (camState === 'idle') startCamera();
  }, [camState, startCamera]);

  // Log every camState transition.
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.log('[mode-b] camState →', camState);
  }, [camState]);

  // Log every runState transition.
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.log('[mode-b] runState →', runState);
  }, [runState]);

  // Pose extractor init — runs once per camera-grant. Previously had
  // `runState` in deps which caused the extractor to be closed and
  // reinitialized on every state transition; specifically, tapping start
  // → setRunState('running') tore down the extractor mid-detection so the
  // scoring loop saw `ex.ready === false` and never accumulated frames,
  // leaving the page apparently hung. Use the functional setState form to
  // transition out of waiting without depending on the current value.
  useEffect(() => {
    if (camState !== 'granted') return;
    let cancelled = false;
    const ex = new PoseExtractor();
    extractorRef.current = ex;
    setPoseStatus('ok');
    // eslint-disable-next-line no-console
    console.log('[mode-b] PoseExtractor.init() starting');
    ex.init()
      .then(() => {
        if (cancelled) {
          // eslint-disable-next-line no-console
          console.log('[mode-b] PoseExtractor.init() resolved after cleanup');
          ex.close();
          return;
        }
        // eslint-disable-next-line no-console
        console.log('[mode-b] PoseExtractor.init() resolved, ex.ready=', ex.ready);
        setRunState((prev) => (prev === 'waiting_for_camera' ? 'ready' : prev));
      })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('[mode-b] PoseExtractor.init() failed', err);
        if (!cancelled) setPoseStatus('failed');
      });
    return () => {
      cancelled = true;
      ex.close();
      extractorRef.current = null;
    };
  }, [camState]);

  // SPECK round-4 §Fix 2: invoked by StartOverlay when its 3-2-1
  // countdown lands on zero. This is the exact instant audio + scoring
  // start, so the user's first dance step lines up with the beat. The
  // emphasis "GO" tick is fired inside the overlay itself.
  // spec.md §Mode-B-countdown-loop fix: deps intentionally omit
  // `audio`. useDanceAudio returns a fresh outer object every render,
  // so including it here made `handleOverlayGo` a new reference each
  // render → flickered the `onGo` prop passed to StartOverlay →
  // re-fired StartOverlay's countdown effect → cleared the 1-second
  // setCount timeout before it elapsed → countdown stuck at 3.
  // The audio methods are stable useCallback([]) refs that operate on
  // audioRef.current, so the closure-captured `audio` calls the right
  // element regardless of which render the closure was created in.
  const handleOverlayGo = useCallback(() => {
    if (!chunk || !dance) return;
    // eslint-disable-next-line no-console
    console.log('[mode-b] handleOverlayGo (countdown reached GO)', {
      startMs: chunk.startMs,
      durationMs: chunk.endMs - chunk.startMs,
    });
    setRunState('running');
    startMsRef.current = performance.now();
    userFramesRef.current = [];
    userLandmarkFramesRef.current = [];
    audio.seekMs(chunk.startMs);
    void audio.play().then((ok) => {
      // eslint-disable-next-line no-console
      console.log('[mode-b] audio.play() resolved', { ok });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunk, dance]);

  // Visibility pause/resume — re-anchor session clock so MediaPipe doesn't
  // see a giant timestamp jump.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVis = () => {
      if (document.hidden) {
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        audio.pause();
      } else if (runState === 'running' && chunk) {
        const elapsedMs = progress * (chunk.endMs - chunk.startMs);
        startMsRef.current = performance.now() - elapsedMs;
        void audio.play();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [runState, progress, chunk, audio]);

  // Detection loop scoped to the chunk's duration.
  useEffect(() => {
    if (runState !== 'running' || !dance || !chunk) return;
    const durationMs = chunk.endMs - chunk.startMs;

    const loop = () => {
      const v = videoRef.current;
      const ex = extractorRef.current;
      const t0 = startMsRef.current ?? performance.now();
      const sessionT = performance.now() - t0;
      setProgress(Math.min(1, sessionT / durationMs));

      if (v && ex?.ready && v.readyState >= 2) {
        const res = ex.detectFromVideo(v, sessionT);
        if (res) {
          lastDetectAtRef.current = performance.now();
          if (poseStatus !== 'ok') setPoseStatus('ok');
          // setLandmarks: the user's own SkeletonOverlay reads this
          // and pairs it with CSS scaleX(-1) on its canvas, so it
          // expects RAW (un-mirrored) landmarks. Don't change that —
          // SkeletonOverlay is shared with Mode A and the spec says
          // hands off Mode A.
          setLandmarks(res.landmarks);

          // MIRROR CHOKEPOINT (see lib/pose/normalize.ts convention):
          // apply mirrorLandmarksHorizontal to user landmarks EXACTLY
          // ONCE here, right at the entry of every downstream
          // consumer that does anatomical-side comparison —
          // DualSkeletonOverlay (visual partner), the scorer's
          // landmark frames, and the live-readout vec. Reference
          // landmarks are never mirrored. The single call lives at
          // this layer so neither the canonical pipeline nor
          // referenceFrames.ts know about mirror state.
          if (res.landmarks.length >= 33) {
            const userMirrored = mirrorLandmarksHorizontal(res.landmarks);
            setUserMirroredLandmarks(userMirrored);

            const vec = compute2DJointAngles(userMirrored);
            const absT = chunk.startMs + sessionT;
            // Tag the frame with the absolute routine timestamp so DTW lines
            // up with the chunk-aligned reference.
            userFramesRef.current.push({
              timestampMs: absT,
              vector: vec,
            });
            userLandmarkFramesRef.current.push({
              timestampMs: absT,
              landmarks: userMirrored,
            });
            // Reference for the live readout: prefer the real
            // worker-extracted pose data; fall back to the synthetic
            // placeholder only when the dance row has no pose JSON.
            let ref = poseData ? referenceFrameAt(poseData, absT) : null;
            if (!ref) {
              ref = neutralReferenceFrame(absT, dance.bpm);
            }
            // Reference landmarks for the dual-skeleton overlay —
            // raw, no mirror. The user side is already pre-mirrored
            // above and DualSkeletonOverlay consumes both as-is.
            if (poseData) {
              setRefLandmarks(landmarkAt(poseData, absT));
            }
            const sim = cosineSimilarity(vec, ref);
            const s = frameScoreFromSimilarity(Math.max(0, sim));
            setLiveScore((prev) => prev * 0.7 + s * 0.3);
            if (sessionT - lastHintAtRef.current >= 200) {
              lastHintAtRef.current = sessionT;
              setHint(correctionHint(vec, ref));
            }
          }
        } else {
          // SPECK §4.2: when detection returns nothing, hide the skeleton
          // rather than freezing the last frame; FramingToast picks this up
          // as zero upper-body confidence (null landmarks → 0) after the
          // configured hold window.
          setLandmarks(null);
          if (performance.now() - lastDetectAtRef.current > 1500) {
            if (poseStatus === 'ok') setPoseStatus('lost');
          }
        }
      }

      if (sessionT >= durationMs) {
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
  }, [runState, dance, chunk, poseStatus]);

  // On finish: compute final score, persist chunk progress.
  useEffect(() => {
    if (runState !== 'finished' || !dance || !chunk) return;
    audio.stop();
    // Prefer the worker's real reference pose data; fall back to the
    // synthetic neutral-pose sequence only when the dance row has no
    // pose_data_url (legacy fixtures, early test rows). The synthetic
    // path is a known-bad scoring source — see docs/scoring-diagnosis.md
    // — but is kept as a graceful fallback so legacy dances still finish
    // a run instead of erroring out.
    const refSeq = poseData
      ? buildReferenceSequence(poseData, chunk.startMs, chunk.endMs)
      : generateReferenceSequence(dance.duration_seconds, dance.bpm).filter(
          (f) => f.timestampMs >= chunk.startMs && f.timestampMs < chunk.endMs,
        );
    // Stage 4 canonical-angle path: when we have real reference pose
    // data we score on landmark frames (canonicalize → joint angles →
    // body-invariant score). Falls back to the legacy vector path for
    // dance rows that have no pose_data_url (synthetic reference is the
    // only option in that case, and the legacy path tolerates it).
    const refLandmarkSeq = poseData
      ? buildReferenceLandmarkSequence(poseData, chunk.startMs, chunk.endMs)
      : null;
    const beatGrid = new BeatTracker(dance.bpm, chunk.startMs).asGrid();
    const result = refLandmarkSeq && refLandmarkSeq.length > 0
      ? scoreSession({
          userLandmarkFrames: userLandmarkFramesRef.current,
          referenceLandmarkFrames: refLandmarkSeq,
          beatGrid,
          skillIds: chunk.skills,
        })
      : scoreSession({
          userFrames: userFramesRef.current,
          referenceFrames: refSeq,
          beatGrid,
          skillIds: chunk.skills,
        });
    setSessionScore(result);
    const overall = Math.round(result.overall);
    setFinalScore(overall);
    const { unlockedNext } = recordChunkScore(dance.id, chunkIndex, overall);
    recordContinueLearning({
      danceId: dance.id,
      title: dance.name,
      displayName: dance.name,
      creatorHandle: dance.artist,
      thumbnailUrl: dance.thumbnail_url,
      totalChunks: chunks.length,
      currentChunkIndex: unlockedNext
        ? Math.min(chunkIndex + 1, chunks.length - 1)
        : chunkIndex,
    });
    setUnlockedNext(unlockedNext);
    // spec.md §Mode-B-countdown-loop fix: `audio` omitted from deps.
    // audio.stop() inside fires a 'pause' event → setState in the
    // hook → new audio ref → effect would re-fire → audio.stop()
    // again → infinite loop. audio.stop is a stable useCallback([])
    // operating on audioRef.current, so the closure call is safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runState, dance, chunk, chunkIndex, chunks.length]);

  // spec.md §Mode-B-countdown-loop fix: ACTIVE loop driver before this
  // patch. `[audio]` made this cleanup re-fire every audio ref change.
  // The cleanup calls audio.stop() → el.pause() → 'pause' event →
  // setState in useDanceAudio → new state → new audio ref → cleanup
  // re-fires → infinite render storm. Symptom on screen: StartOverlay's
  // countdown stuck at 3 because handleOverlayGo flickers every render
  // and StartOverlay's countdown effect (which has onGo in deps) keeps
  // clearing the 1s setCount timer before it elapses. Empty deps make
  // this a true unmount-only cleanup; audio.stop is a stable useCallback
  // operating on audioRef.current, so the closure-captured call still
  // hits the live audio element.
  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      audio.stop();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (!loading && (notFound || (dance && !chunk))) {
      router.replace(`/dance/${params.danceId}`);
    }
  }, [loading, notFound, dance, chunk, router, params.danceId]);

  if (loading || !dance || !chunk) {
    return (
      <main className="flex h-full items-center justify-center text-text-muted">
        Loading…
      </main>
    );
  }


  return (
    <main className="relative flex h-full w-full flex-col bg-black">
      {/* SPECK polish §Fix 7: header now structurally matches Mode A
          (h-[50px], same label hierarchy) so the layout doesn't lurch
          when moving between copy and test. BackHomeButton kept since
          the user has no other way out mid-test. */}
      <header className="safe-top relative z-30 flex h-[50px] items-center gap-3 px-4">
        <BackHomeButton />
        <div className="flex-1 text-center">
          <div className="text-[10px] uppercase tracking-widest text-white/50">
            test · chunk {chunkIndex + 1}/{chunks.length}
          </div>
          <div className="truncate text-sm font-semibold">{chunk.label}</div>
        </div>
        <VolumeControl volume={volume} onChange={setVolume} />
      </header>

      <div className="relative flex-1 overflow-hidden bg-bg-card">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className="absolute inset-0 h-full w-full object-cover [transform:scaleX(-1)]"
        />
        <SkeletonOverlay landmarks={landmarks} videoRef={videoRef} mirror staleAfterMs={400} />

        {/* Dual-skeleton overlay: reference dancer in white, user in
            coral, both normalized to a shared hip-midpoint origin. Lets
            the user see in real time where their move diverges from the
            reference. Default-on; toggle button below. Only useful
            while running — and only when we actually have real reference
            data to draw. */}
        {showDual && runState === 'running' && hasRealReference && (
          <div className="pointer-events-none absolute inset-0 z-10">
            <DualSkeletonOverlay
              userLandmarks={userMirroredLandmarks}
              referenceLandmarks={refLandmarks}
            />
          </div>
        )}

        {runState === 'running' && <FramingToast landmarks={landmarks} />}

        {/* Chunk progress dots — moved below the safe-top inset so the
            iOS status bar / notch doesn't clip them on a 390px viewport. */}
        <div className="pointer-events-none absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2">
          {chunks.map((c) => (
            <span
              key={c.index}
              className={`h-1 w-5 rounded-full ${
                c.index === chunkIndex
                  ? 'bg-white'
                  : c.index < chunkIndex
                    ? 'bg-white/60'
                    : 'bg-white/20'
              }`}
              aria-hidden
            />
          ))}
        </div>

        <div className="absolute left-3 top-10 z-10">
          <CorrectionToast hint={runState === 'running' ? hint : null} />
        </div>

        {poseStatus !== 'ok' && runState === 'running' && (
          <div className="absolute inset-x-0 top-20 z-10 mx-auto w-fit rounded-full bg-accent-amber/20 px-3 py-1.5 text-xs font-semibold text-accent-amber ring-1 ring-accent-amber/40 backdrop-blur-sm">
            {poseStatus === 'lost'
              ? 'pose tracking lost, repositioning…'
              : 'pose tracker unavailable'}
          </div>
        )}

        {/* SPECK polish §Fix 7: score pill lifted off the bottom edge so
            it never sits underneath the user's hands at the bottom of
            the camera frame nor collides with the progress bar below. */}
        <div className="absolute right-3 bottom-6 z-20 rounded-full bg-black/70 px-3 py-1.5 text-sm font-bold tabular-nums text-white ring-1 ring-white/15">
          {Math.round(liveScore)}
        </div>

        {/* Dual-skeleton overlay toggle. Default on for development; the
            user can flip it via this button and the choice is persisted
            in localStorage (lib/scoring/uiPrefs.ts). Hidden when there's
            no real reference data — would be misleading. */}
        {hasRealReference && runState !== 'finished' && (
          <button
            type="button"
            onClick={() => {
              const next = !showDual;
              setShowDual(next);
              setDualOverlayEnabled(next);
            }}
            className="absolute left-3 bottom-6 z-20 rounded-full bg-black/70 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-white/80 ring-1 ring-white/15"
          >
            skeletons {showDual ? 'on' : 'off'}
          </button>
        )}

        {/* Camera blocked / unavailable: surface as the ONLY overlay so
            the user can recover. Other camState transitions
            (idle/requesting/granted/needs_tap) are hidden behind the
            StartOverlay below — the user's tap on StartOverlay's
            "start" carries the iOS user-gesture that attachStream
            needs, so we no longer need a separate camera-tap fallback
            button. */}
        {(camState === 'denied' || camState === 'unavailable') &&
          runState !== 'running' &&
          runState !== 'finished' && (
            <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-black p-8 text-center">
              {camState === 'denied' ? (
                <>
                  <div className="text-2xl font-bold">Camera blocked</div>
                  <p className="mt-2 text-sm text-text-muted">
                    Enable camera in browser settings and reload.
                  </p>
                  <button
                    type="button"
                    onClick={startCamera}
                    className="mt-6 rounded-full bg-white px-6 py-2.5 text-sm font-bold text-black"
                  >
                    Try again
                  </button>
                </>
              ) : (
                <div className="text-sm text-text-muted">camera unavailable</div>
              )}
            </div>
          )}

        {/* spec.md §Mode-B-one-start-button fix: StartOverlay now shows
            during BOTH waiting_for_camera AND ready states. The single
            "start" button serves as the iOS camera-tap gesture (via
            onStart → handleTapToStart) AND the countdown trigger. If
            the camera + extractor aren't ready by the time the 3-2-1
            countdown reaches GO, the detection loop tolerates it —
            ex.ready guards each frame, so scoring just picks up once
            the extractor finishes initializing. */}
        {(runState === 'waiting_for_camera' || runState === 'ready') &&
          camState !== 'denied' &&
          camState !== 'unavailable' && (
            <StartOverlay
              chunkNumber={chunkIndex + 1}
              totalChunks={chunks.length}
              chunkLabel={chunk.label ?? `section ${chunkIndex + 1}`}
              subtitle="ready to dance?"
              onStart={() => {
                // eslint-disable-next-line no-console
                console.log('[mode-b] StartOverlay onStart (camState=', camState, ')');
                // Always safe to call: routes through attachStream
                // with the live user gesture from this tap.
                void handleTapToStart();
              }}
              onGo={handleOverlayGo}
            />
          )}

        {/* Final score card. Replaces the old "Almost there / 18 /
            threshold 70" popup with a component-aware results screen.
            See components/ResultsCard.tsx and SPECK Stage 5. */}
        {runState === 'finished' && finalScore !== null && (
          <ResultsCard
            danceId={dance.id}
            chunkIndex={chunkIndex}
            totalChunks={chunks.length}
            finalScore={finalScore}
            sessionScore={sessionScore}
            unlockedNext={unlockedNext}
            onRetry={() => {
              setRunState('ready');
              setFinalScore(null);
              setSessionScore(null);
              setLiveScore(0);
              setProgress(0);
            }}
          />
        )}
      </div>

      {/* SPECK polish §Fix 7: bottom bar has explicit safe-bottom + a
          minimum tap-target's worth of room above the home indicator so
          the progress bar never lands underneath the iOS gesture area. */}
      <div className="safe-bottom relative z-30 flex h-[56px] items-center bg-black px-4">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full bg-white transition-[width] duration-100"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      </div>
    </main>
  );
}
