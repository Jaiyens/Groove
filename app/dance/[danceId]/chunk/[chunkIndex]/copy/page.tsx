'use client';

// Mode A — copy-along chunk practice.
//
// Reference video plays full-bleed vertical, takes ~70% of screen.
// Camera feed is a small PIP overlay in the bottom-right (Duet style).
// Reference loops over [chunk.startMs, chunk.endMs] at the chosen speed.
// No skeleton overlay. No score. Just mirror practice.
// Bottom CTA: "I got it" → Mode B (test) for the same chunk.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import BackHomeButton from '@/components/BackHomeButton';
import SpeedToggle from '@/components/SpeedToggle';
import VolumeControl from '@/components/VolumeControl';
import { getDance } from '@/lib/dances/fixtures';
import { useGraph } from '@/lib/graph/context';
import { chunkRoutine, type Chunk } from '@/lib/graph/chunker';
import { isRoutineNode } from '@/lib/graph/types';
import { attachStream } from '@/lib/pose/cameraAttach';

type CamState = 'idle' | 'requesting' | 'granted' | 'needs_tap' | 'denied' | 'unavailable';

interface PageProps {
  params: { danceId: string; chunkIndex: string };
}

const SPEED_OPTIONS = [0.5, 0.75, 1] as const;

export default function CopyAlongPage({ params }: PageProps) {
  const router = useRouter();
  const { graph } = useGraph();
  const chunkIndex = Number(params.chunkIndex);

  const dance = useMemo(
    () => (graph ? getDance(params.danceId, graph) : undefined),
    [graph, params.danceId],
  );

  const chunks = useMemo<Chunk[]>(() => {
    if (!graph || !dance) return [];
    const node = graph.nodes.find((n) => n.id === dance.id);
    if (!node || !isRoutineNode(node)) return [];
    return chunkRoutine(node, {
      nameOf: (id) => graph.nodes.find((n) => n.id === id)?.name,
    });
  }, [graph, dance]);

  const chunk = chunks[chunkIndex];

  const refVideoRef = useRef<HTMLVideoElement | null>(null);
  const camVideoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [rate, setRate] = useState(0.6);
  const [volume, setVolume] = useState(1);
  const [camState, setCamState] = useState<CamState>('idle');
  const [pipSwapped, setPipSwapped] = useState(false);
  const [refMissing, setRefMissing] = useState(false);

  useEffect(() => {
    if (graph && (!dance || !chunk)) router.replace(`/dance/${params.danceId}`);
  }, [graph, dance, chunk, router, params.danceId]);

  // Camera attach (PIP feed; no pose tracking in Mode A).
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
      const v = camVideoRef.current;
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

  useEffect(() => {
    if (camState === 'idle') startCamera();
  }, [camState, startCamera]);

  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    },
    [],
  );

  // Reference-video chunk-loop driver. We seek to chunk.startMs whenever the
  // current time crosses chunk.endMs, and we keep playbackRate + volume in
  // sync with React state.
  useEffect(() => {
    const v = refVideoRef.current;
    if (!v || !chunk) return;
    v.playbackRate = rate;
    v.volume = volume;
    const onTimeUpdate = () => {
      const tMs = v.currentTime * 1000;
      if (tMs >= chunk.endMs || tMs < chunk.startMs - 50) {
        v.currentTime = chunk.startMs / 1000;
      }
    };
    const onLoaded = () => {
      v.currentTime = chunk.startMs / 1000;
      v.playbackRate = rate;
      v.volume = volume;
      void v.play().catch(() => {});
    };
    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('loadedmetadata', onLoaded);
    if (v.readyState >= 1) onLoaded();
    return () => {
      v.removeEventListener('timeupdate', onTimeUpdate);
      v.removeEventListener('loadedmetadata', onLoaded);
    };
  }, [chunk, rate, volume]);

  if (!graph || !dance || !chunk) {
    return (
      <main className="flex h-full items-center justify-center text-text-muted">
        Loading…
      </main>
    );
  }

  const chunkDurationSec = (chunk.endMs - chunk.startMs) / 1000;

  return (
    <main className="relative flex h-full w-full flex-col bg-black">
      <header className="safe-top relative z-30 flex items-center gap-3 px-4 pt-3 pb-2">
        <BackHomeButton />
        <div className="flex-1 text-center">
          <div className="text-[10px] uppercase tracking-widest text-text-muted">
            Copy along · chunk {chunkIndex + 1}/{chunks.length}
          </div>
          <div className="truncate text-sm font-bold">{chunk.label}</div>
        </div>
        <VolumeControl volume={volume} onChange={setVolume} />
      </header>

      <div className="relative flex-1 overflow-hidden bg-bg-card">
        {/* Reference video — full bleed */}
        <video
          ref={refVideoRef}
          src={dance.video_url}
          playsInline
          muted={volume <= 0.001}
          autoPlay
          loop={false}
          onError={() => setRefMissing(true)}
          className="absolute inset-0 h-full w-full object-cover"
          aria-label={`${dance.name} reference video`}
        />

        {refMissing && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-br from-bg-card to-black text-center p-6">
            <div className="text-xs uppercase tracking-widest text-accent">
              reference video missing
            </div>
            <p className="mt-2 max-w-xs text-sm text-text-muted">
              Drop <code className="text-white">{dance.video_url.split('/').pop()}</code>
              {' '}into <code className="text-white">/public/data/reference_dances/</code>
              {' '}— the copy-along will resume automatically.
            </p>
          </div>
        )}

        {/* PiP user camera — bottom-right by default, swap to swap roles */}
        <button
          type="button"
          onClick={() => setPipSwapped((s) => !s)}
          aria-label="Swap PIP / reference"
          className={`absolute z-10 overflow-hidden rounded-2xl shadow-2xl ring-2 ring-white/80 transition-all ${
            pipSwapped
              ? 'inset-x-3 top-3 h-2/3 w-auto'
              : 'right-3 bottom-24 h-40 w-28'
          }`}
        >
          {camState === 'granted' ? (
            <video
              ref={camVideoRef}
              playsInline
              muted
              autoPlay
              className="h-full w-full object-cover [transform:scaleX(-1)]"
            />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center bg-black p-2 text-center">
              {camState === 'requesting' ? (
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              ) : camState === 'denied' ? (
                <span className="text-[10px] text-accent-red">camera blocked</span>
              ) : camState === 'unavailable' ? (
                <span className="text-[10px] text-text-muted">no camera</span>
              ) : (
                <span className="text-[10px] text-text-muted">tap to start</span>
              )}
            </div>
          )}
        </button>

        {/* Chunk progress dots overlay */}
        <div className="pointer-events-none absolute left-1/2 top-3 z-10 flex -translate-x-1/2 gap-1.5">
          {chunks.map((c) => (
            <span
              key={c.index}
              className={`h-1 w-6 rounded-full ${
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
      </div>

      {/* Bottom controls */}
      <div className="safe-bottom relative z-30 flex flex-col gap-3 bg-black px-4 pt-3 pb-4">
        <div className="flex items-center justify-between">
          <SpeedToggle rate={rate} onChange={setRate} options={SPEED_OPTIONS} />
          <div className="text-right text-[11px] text-text-muted">
            <div>{chunkDurationSec.toFixed(1)}s chunk</div>
            <div>looping at {Math.round(rate * 100)}%</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/dance/${dance.id}`}
            className="flex-1 rounded-full bg-bg-card py-3 text-center text-sm font-bold text-white ring-1 ring-white/10 active:scale-[0.98]"
          >
            Back to lesson
          </Link>
          <Link
            href={`/dance/${dance.id}/chunk/${chunkIndex}/test`}
            className="flex-[2] rounded-full bg-white py-3 text-center text-sm font-bold text-black active:scale-[0.98]"
          >
            I got it · test
          </Link>
        </div>
      </div>
    </main>
  );
}
