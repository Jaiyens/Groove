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
import CalloutOverlay from '@/components/scoring/CalloutOverlay';
import SideBySideHoldingScreen from '@/components/scoring/SideBySideHoldingScreen';
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
  createCalloutEngine,
  deriveAccentBeatsFromBpm,
} from '@/lib/scoring/callouts/calloutEngine';
import type { CalloutEvent } from '@/lib/scoring/callouts/types';
import { scoreWithGemini } from '@/lib/scoring/gemini/client';
import { detectLegsVisible } from '@/lib/scoring/legVisibility';
import { buildFinalScoreView, type FinalScoreView } from '@/lib/scoring/finalScore';
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

// Wraps the recorder.stop()/'stop' event so the caller gets the final Blob
// in a promise. Returns null if no recorder or no chunks (e.g. browser
// without MediaRecorder support).
function stopRecorderAndGetBlob(
  rec: MediaRecorder | null,
): Promise<Blob | null> {
  if (!rec) return Promise.resolve(null);
  return new Promise<Blob | null>((resolve) => {
    const settle = (blob: Blob | null) => resolve(blob);
    rec.onstop = () => {
      // recordedChunksRef is populated by ondataavailable on the page.
      // We can't reach that ref from here, so callers should swap blobs
      // out of recordedChunksRef.current after stop resolves. For ergonomic
      // call sites we read chunks via a closure over the recorder's
      // ondataavailable accumulator below.
      const blob = new Blob(recorderChunks(rec), { type: rec.mimeType || 'video/webm' });
      settle(blob.size > 0 ? blob : null);
    };
    if (rec.state === 'inactive') {
      // Already stopped — resolve with whatever chunks landed.
      const blob = new Blob(recorderChunks(rec), { type: rec.mimeType || 'video/webm' });
      settle(blob.size > 0 ? blob : null);
      return;
    }
    try {
      rec.requestData();
    } catch {
      // ignore — some browsers don't support requestData mid-flight
    }
    try {
      rec.stop();
    } catch {
      settle(null);
    }
  });
}

// MediaRecorder doesn't expose recorded chunks directly, so we stash the
// array on the recorder object via a WeakMap so the helper above can pull
// them out without the page passing the ref through. This is a tiny bit of
// indirection that keeps the page code clean.
const recorderChunksMap = new WeakMap<MediaRecorder, Blob[]>();
function recorderChunks(rec: MediaRecorder): Blob[] {
  return recorderChunksMap.get(rec) ?? [];
}
function attachRecorderChunks(rec: MediaRecorder, chunks: Blob[]): void {
  recorderChunksMap.set(rec, chunks);
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
  // MediaRecorder for the camera-only attempt video that Gemini scores
  // against. We record video tracks only (audio is the reference dance
  // played through the speaker, capturing it would create echo).
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const attemptBlobUrlRef = useRef<string | null>(null);
  // Callout engine + latest CalloutEvent for the overlay to react to.
  // The event is stored in state (not a ref) because the overlay needs
  // a re-render to pick up the new event; identity-equality drives
  // the animation retrigger.
  const calloutEngineRef = useRef<ReturnType<typeof createCalloutEngine> | null>(null);
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
  // Latest live-callout event for CalloutOverlay. New event identity =
  // re-trigger the animation.
  const [latestCallout, setLatestCallout] = useState<CalloutEvent | null>(null);
  // Captured attempt video URL for HoldingScreen + Gemini.
  const [attemptBlobUrl, setAttemptBlobUrl] = useState<string | null>(null);
  // Post-attempt flow:
  //   running → finished + (HoldingScreen) → holdingDone + finalView → ResultsCard
  // Holding screen sits at least 3s even if Gemini is fast.
  const [holdingDone, setHoldingDone] = useState(false);
  const [finalView, setFinalView] = useState<FinalScoreView | null>(null);
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
    setLatestCallout(null);
    setAttemptBlobUrl(null);
    setHoldingDone(false);
    setFinalView(null);
    if (attemptBlobUrlRef.current) {
      URL.revokeObjectURL(attemptBlobUrlRef.current);
      attemptBlobUrlRef.current = null;
    }

    // Callout engine: derive accent beats every-2nd-beat from BPM, no
    // separate beat detector needed (audio is reference dance audio
    // and the BPM is already known). Timestamps are session-relative
    // (ms since GO) so they match the ingestFrame timestamps we feed
    // it from the detection loop. SPECK §working-agreement: if accent
    // beats aren't reliable, fall back to every-800ms — handled inside
    // deriveAccentBeatsFromBpm.
    const sessionDurationMs = chunk.endMs - chunk.startMs;
    const accentBeats = deriveAccentBeatsFromBpm(0, sessionDurationMs, dance.bpm);
    calloutEngineRef.current = createCalloutEngine({
      accentBeatTimestamps: accentBeats,
      onCallout: (event) => setLatestCallout(event),
    });

    // MediaRecorder: capture the camera-only stream so the post-
    // attempt grader (Gemini) gets a real attempt video. We record
    // video only — audio is the reference dance being played out the
    // speaker, capturing it would echo into Gemini's input.
    recordedChunksRef.current = [];
    try {
      const liveStream = streamRef.current;
      if (liveStream) {
        const videoOnly = new MediaStream(liveStream.getVideoTracks());
        // Prefer webm/vp9, but fall back to whatever the browser ships.
        const mimeType =
          typeof MediaRecorder !== 'undefined' &&
          MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
            ? 'video/webm;codecs=vp9'
            : typeof MediaRecorder !== 'undefined' &&
                MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
              ? 'video/webm;codecs=vp8'
              : 'video/webm';
        const rec = new MediaRecorder(videoOnly, { mimeType });
        const chunks: Blob[] = [];
        recordedChunksRef.current = chunks;
        attachRecorderChunks(rec, chunks);
        rec.ondataavailable = (ev) => {
          if (ev.data && ev.data.size > 0) chunks.push(ev.data);
        };
        recorderRef.current = rec;
        rec.start();
        // eslint-disable-next-line no-console
        console.log('[mode-b] MediaRecorder started', { mimeType });
      } else {
        // eslint-disable-next-line no-console
        console.warn('[mode-b] no live stream to record — Gemini will be skipped');
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[mode-b] MediaRecorder init failed', err);
      recorderRef.current = null;
    }

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
            // Live callout engine: similarity is the SAME score the
            // existing pipeline computes (cosine over joint angles, range
            // -1..1 but in practice ~0..1 for similar poses). Per SPECK
            // §Hard rule 3 we feed the existing stream, do not recompute.
            calloutEngineRef.current?.ingestFrame({
              timestamp: sessionT,
              similarity: Math.max(0, sim),
            });
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

  // On finish: stop the recorder, kick off MediaPipe final + Gemini in
  // parallel, then assemble the unified FinalScoreView once both
  // resolve. Holding screen owns the "wait" UI in the meantime.
  // spec.md §Mode-B-countdown-loop fix: `audio` omitted from deps —
  // audio.stop is a stable useCallback([]) so the closure call hits
  // the live element. Pulling `audio` in would re-fire on every audio
  // state change (new outer ref) and re-trigger the whole finish flow.
  useEffect(() => {
    if (runState !== 'finished' || !dance || !chunk) return;
    audio.stop();

    // Pull the recorded video off MediaRecorder. requestData() flushes
    // the current chunk; the actual Blob is assembled after 'stop' fires.
    // We capture inside an async IIFE so the parallel scoring can start
    // without blocking the effect's render commit.
    const finalize = async () => {
      const attemptBlob = await stopRecorderAndGetBlob(recorderRef.current);
      recorderRef.current = null;
      let blobUrl: string | null = null;
      if (attemptBlob) {
        blobUrl = URL.createObjectURL(attemptBlob);
        attemptBlobUrlRef.current = blobUrl;
        setAttemptBlobUrl(blobUrl);
      }

      // MediaPipe final scoring — same code path the rebuilt scorer
      // already uses (SPECK §Hard rule 3: do not modify MediaPipe
      // scoring; add to it).
      const refSeq = poseData
        ? buildReferenceSequence(poseData, chunk.startMs, chunk.endMs)
        : generateReferenceSequence(dance.duration_seconds, dance.bpm).filter(
            (f) => f.timestampMs >= chunk.startMs && f.timestampMs < chunk.endMs,
          );
      const refLandmarkSeq = poseData
        ? buildReferenceLandmarkSequence(poseData, chunk.startMs, chunk.endMs)
        : null;
      const beatGrid = new BeatTracker(dance.bpm, chunk.startMs).asGrid();
      const mediapipeFinal =
        refLandmarkSeq && refLandmarkSeq.length > 0
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

      // Parallel Gemini scoring. Only run if we have both a recorded
      // attempt and a reference video URL. On failure the client returns
      // a tagged error — never throws — so the silent-fallback path is
      // built in. Pass the chunk window so the client can trim the
      // reference (SPECK §windowing-fix) and the inferred leg-visibility
      // flag so Gemini downweights legs when the user filmed upper body
      // only.
      const legsVisible = detectLegsVisible(userLandmarkFramesRef.current);
      // eslint-disable-next-line no-console
      console.log('[mode-b] legsVisible →', legsVisible, {
        landmarkFrames: userLandmarkFramesRef.current.length,
      });
      const geminiPromise =
        attemptBlob && dance.video_url
          ? scoreWithGemini({
              attemptBlob,
              referenceVideoUrl: dance.video_url,
              chunkStartMs: chunk.startMs,
              chunkEndMs: chunk.endMs,
              legsVisible,
            })
          : Promise.resolve({
              kind: 'error' as const,
              reason: attemptBlob ? 'no reference video' : 'no attempt recorded',
            });

      const geminiResult = await geminiPromise;
      if (geminiResult.kind === 'error') {
        // eslint-disable-next-line no-console
        console.warn('[mode-b] gemini failed → falling back to MediaPipe', geminiResult.reason);
      } else {
        // eslint-disable-next-line no-console
        console.log('[mode-b] gemini scored (raw, internal)', {
          overall: geminiResult.score.overall_score,
          tier: geminiResult.score.tier,
          latencyMs: geminiResult.latencyMs,
        });
      }

      const view = buildFinalScoreView(geminiResult, mediapipeFinal, chunk.startMs, legsVisible);
      setSessionScore(mediapipeFinal);
      setFinalView(view);
      // Display score is what the user sees AND what gates chunk unlock —
      // the deterministic formula is the headline number, Gemini's raw
      // overall_score is logged for debugging only (SPECK §Hard rule 2).
      const display = view.display.displayScore;
      setFinalScore(display);
      const { unlockedNext } = recordChunkScore(dance.id, chunkIndex, display);
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
    };

    void finalize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runState, dance, chunk, chunkIndex, chunks.length, poseData]);

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
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        try {
          recorderRef.current.stop();
        } catch {
          // ignore — best-effort teardown
        }
      }
      if (attemptBlobUrlRef.current) {
        URL.revokeObjectURL(attemptBlobUrlRef.current);
        attemptBlobUrlRef.current = null;
      }
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

        {/* Live-callout overlay: GROOVY / PERFECT / GREAT / ALMOST flash
            on accent beats during the run. Vibe layer only — does not
            influence final scoring (SPECK §Hard rule 1). Z-index 20 inside
            the overlay; sits above the dual-skeleton overlay (z-10) but
            below the results card (z-40). */}
        {runState === 'running' && <CalloutOverlay event={latestCallout} />}

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

        {/* Side-by-side holding screen: shown immediately after the
            attempt ends, sits for at least 3s while MediaPipe final +
            Gemini run in parallel. Renders REFERENCE left, YOU right —
            both videos play in sync, each with its own skeleton. The
            reference skeleton only draws when the dance has precomputed
            pose data; otherwise the reference panel is video-only
            (SPECK §SideBySide). */}
        {runState === 'finished' && !holdingDone && attemptBlobUrl && chunk && dance.video_url && (
          <SideBySideHoldingScreen
            attemptBlobUrl={attemptBlobUrl}
            referenceVideoUrl={dance.video_url}
            userLandmarkFrames={userLandmarkFramesRef.current}
            referencePoseData={poseData ?? null}
            chunkStartMs={chunk.startMs}
            chunkEndMs={chunk.endMs}
            geminiResolved={finalView !== null}
            onReady={() => setHoldingDone(true)}
          />
        )}

        {/* Final score card. Gemini's score is the headline (or, when
            Gemini failed, MediaPipe in Gemini-shape via the adapter).
            See components/ResultsCard.tsx and SPECK §results. */}
        {runState === 'finished' &&
          finalScore !== null &&
          finalView !== null &&
          (holdingDone || !attemptBlobUrl) && (
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
                setFinalView(null);
                setHoldingDone(false);
                setAttemptBlobUrl(null);
                if (attemptBlobUrlRef.current) {
                  URL.revokeObjectURL(attemptBlobUrlRef.current);
                  attemptBlobUrlRef.current = null;
                }
                setLiveScore(0);
                setProgress(0);
              }}
              finalView={finalView}
              chunkStartMs={chunk.startMs}
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
