// MediaPipe Pose Landmarker wrapper. Browser-only (uses WASM + WebGL).
//
// One PoseLandmarker instance per running mode is required by MediaPipe.
// We lazily init separate live / video instances on demand.

'use client';

import type {
  FilesetResolver as FilesetResolverType,
  PoseLandmarker as PoseLandmarkerType,
  PoseLandmarkerResult,
} from '@mediapipe/tasks-vision';
import type { PoseLandmark, PoseResult } from './types';

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';

let _vision: typeof import('@mediapipe/tasks-vision') | null = null;
let _filesetPromise: Promise<unknown> | null = null;

async function loadFileset() {
  if (!_vision) {
    _vision = await import('@mediapipe/tasks-vision');
  }
  if (!_filesetPromise) {
    const { FilesetResolver } = _vision as { FilesetResolver: typeof FilesetResolverType };
    _filesetPromise = FilesetResolver.forVisionTasks(WASM_BASE);
  }
  return { vision: _vision, fileset: await _filesetPromise };
}

function toLandmarks(
  raw: { x: number; y: number; z: number; visibility?: number }[] | undefined,
): PoseLandmark[] {
  if (!raw) return [];
  return raw.map((p) => ({
    x: p.x,
    y: p.y,
    z: p.z,
    visibility: p.visibility ?? 1,
  }));
}

export class PoseExtractor {
  private live: PoseLandmarkerType | null = null;
  private video: PoseLandmarkerType | null = null;

  // Public flag for UI. Set true after first successful init().
  ready = false;

  // @mediapipe/tasks-vision only supports 'IMAGE' | 'VIDEO'. Real-time camera
  // input uses 'VIDEO' with monotonically increasing timestamps — that's the
  // "live-stream" pattern in this SDK.
  private async createLandmarker(
    runningMode: 'IMAGE' | 'VIDEO',
  ): Promise<PoseLandmarkerType> {
    const { vision, fileset } = await loadFileset();
    const PoseLandmarker = (vision as { PoseLandmarker: typeof PoseLandmarkerType })
      .PoseLandmarker;
    return PoseLandmarker.createFromOptions(
      fileset as Parameters<typeof PoseLandmarker.createFromOptions>[0],
      {
        baseOptions: {
          modelAssetPath: MODEL_URL,
          delegate: 'GPU',
        },
        runningMode,
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        outputSegmentationMasks: false,
      },
    );
  }

  async init(): Promise<void> {
    if (!this.live) {
      this.live = await this.createLandmarker('VIDEO');
    }
    this.ready = true;
  }

  async initVideoMode(): Promise<void> {
    if (!this.video) {
      this.video = await this.createLandmarker('VIDEO');
    }
  }

  detectFromVideo(video: HTMLVideoElement, timestampMs: number): PoseResult | null {
    if (!this.live) return null;
    let result: PoseLandmarkerResult | undefined;
    // detectForVideo accepts ImageSource (HTMLVideoElement is fine).
    try {
      result = this.live.detectForVideo(video, timestampMs);
    } catch {
      return null;
    }
    return resultToPoseResult(result, timestampMs);
  }

  detectFromImage(image: HTMLImageElement): PoseResult | null {
    if (!this.live) return null;
    // detectForVideo also accepts images; switching to IMAGE mode would require
    // a separate instance. For the still-image smoke test in dev, we use the
    // current timestamp.
    const t = performance.now();
    try {
      const result = this.live.detectForVideo(image, t);
      return resultToPoseResult(result, t);
    } catch {
      return null;
    }
  }

  detectFromReferenceVideo(
    video: HTMLVideoElement,
    timestampMs: number,
  ): PoseResult | null {
    if (!this.video) return null;
    try {
      const result = this.video.detectForVideo(video, timestampMs);
      return resultToPoseResult(result, timestampMs);
    } catch {
      return null;
    }
  }

  close() {
    this.live?.close();
    this.video?.close();
    this.live = null;
    this.video = null;
    this.ready = false;
  }
}

function resultToPoseResult(
  result: PoseLandmarkerResult | undefined,
  timestampMs: number,
): PoseResult | null {
  if (!result || !result.landmarks || result.landmarks.length === 0) return null;
  const landmarks = toLandmarks(result.landmarks[0]);
  const worldLandmarks = toLandmarks(result.worldLandmarks?.[0]);
  return { landmarks, worldLandmarks, timestampMs };
}
