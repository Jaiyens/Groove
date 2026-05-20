'use client';

// Mode A — copy-along chunk practice.
//
// Reference is the worker-generated SKELETON VIDEO (silent). Audio plays
// in parallel via useDanceAudio. Both loop over [chunk.startMs, chunk.endMs]
// at the chosen speed (50/75/100%).
//
// User camera shows as a small PIP overlay; tap to swap roles.
// No skeleton overlay on the user (Mode A is just mirror practice).
// Bottom CTA: "I got it · test" → Mode B for the same chunk.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import BackHomeButton from '@/components/BackHomeButton';
import SpeedToggle from '@/components/SpeedToggle';
import VolumeControl from '@/components/VolumeControl';
import { useDance } from '@/lib/dances/useDance';
import { useDanceAudio } from '@/lib/audio/danceAudio';
import { attachStream } from '@/lib/pose/cameraAttach';

type CamState = 'idle' | 'requesting' | 'granted' | 'needs_tap' | 'denied' | 'unavailable';

interface PageProps {
  params: { danceId: string; chunkIndex: string };
}

const SPEED_OPTIONS = [0.5, 0.75, 1] as const;

export default function CopyAlongPage({ params }: PageProps) {
  const router = useRouter();
  const chunkIndex = Number(params.chunkIndex);
  const { loading, notFound, dance, chunks } = useDance(params.danceId);
  const chunk = chunks[chunkIndex];

  const refVideoRef = useRef<HTMLVideoElement | null>(null);
  const camVideoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [rate, setRate] = useState(0.6);
  const [volume, setVolume] = useState(1);
  const [camState, setCamState] = useState<CamState>('idle');
  const [pipSwapped, setPipSwapped] = useState(false);
  const [refMissing, setRefMissing] = useState(false);

  const audio = useDanceAudio(dance?.audio_url ?? null, {
    initialPlaybackRate: rate,
    initialVolume: volume,
    loop: false,
  });

  // Bail if dance / chunk vanish
  useEffect(() => {
    if (!loading && (notFound || (dance && !chunk))) {
      router.replace(`/dance/${params.danceId}`);
    }
  }, [loading, notFound, dance, chunk, router, params.danceId]);

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

  // Audio rate + volume sync.
  useEffect(() => {
    audio.setPlaybackRate(rate);
  }, [rate, audio]);
  useEffect(() => {
    audio.setVolume(volume);
  }, [volume, audio]);

  // Reference (skeleton) video chunk-loop driver.
  useEffect(() => {
    const v = refVideoRef.current;
    if (!v || !chunk) return;
    v.playbackRate = rate;
    v.muted = true; // skeleton is silent; audio is separate
    const onTimeUpdate = () => {
      const tMs = v.currentTime * 1000;
      if (tMs >= chunk.endMs || tMs < chunk.startMs - 50) {
        v.currentTime = chunk.startMs / 1000;
        audio.seekMs(chunk.startMs);
      }
    };
    const onLoaded = () => {
      v.currentTime = chunk.startMs / 1000;
      v.playbackRate = rate;
      audio.seekMs(chunk.startMs);
      void v.play().catch(() => {});
      void audio.play();
    };
    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('loadedmetadata', onLoaded);
    if (v.readyState >= 1) onLoaded();
    return () => {
      v.removeEventListener('timeupdate', onTimeUpdate);
      v.removeEventListener('loadedmetadata', onLoaded);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunk, rate]);

  // Cleanup audio on unmount
  useEffect(() => () => audio.stop(), [audio]);

  if (loading || !dance || !chunk) {
    return (
      <main className="flex h-full items-center justify-center bg-black text-white/60">
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
            copy along · chunk {chunkIndex + 1}/{chunks.length}
          </div>
          <div className="truncate text-sm font-bold">{chunk.label}</div>
        </div>
        <VolumeControl volume={volume} onChange={setVolume} />
      </header>

      <div className="relative flex-1 overflow-hidden bg-bg-card">
        <video
          ref={refVideoRef}
          src={dance.video_url}
          playsInline
          muted
          autoPlay
          loop={false}
          onError={() => setRefMissing(true)}
          className="absolute inset-0 h-full w-full object-cover"
          aria-label={`${dance.name} skeleton reference`}
        />

        {refMissing && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-br from-bg-card to-black text-center p-6">
            <div className="text-xs uppercase tracking-widest text-accent">
              skeleton video unavailable
            </div>
            <p className="mt-2 max-w-xs text-sm text-text-muted">
              The worker hasn’t finished rendering this dance’s skeleton mp4.
              Try going back and resubmitting.
            </p>
          </div>
        )}

        {/* PiP user camera */}
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
            className="flex-[2] rounded-full bg-coral py-3 text-center text-sm font-bold text-white active:scale-[0.98]"
          >
            I got it · test
          </Link>
        </div>
      </div>
    </main>
  );
}
