'use client';

import { useEffect, useRef, useState } from 'react';
import type { Dance } from '@/lib/dances/types';

interface ReferenceVideoProps {
  dance: Dance;
  // Optional ref to receive the underlying <video> element (for syncing).
  videoRef?: React.MutableRefObject<HTMLVideoElement | null>;
  autoplay?: boolean;
  muted?: boolean;
}

export default function ReferenceVideo({
  dance,
  videoRef,
  autoplay = true,
  muted = true,
}: ReferenceVideoProps) {
  const localRef = useRef<HTMLVideoElement | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (videoRef) videoRef.current = localRef.current;
  }, [videoRef]);

  const src = dance.video_url ?? dance.skeleton_video_url ?? undefined;
  return (
    <div className="relative h-full w-full overflow-hidden rounded-xl ring-1 ring-white/10 bg-bg-card">
      <video
        ref={localRef}
        src={src}
        playsInline
        muted={muted}
        autoPlay={autoplay}
        loop
        className="h-full w-full object-cover"
        onError={() => setMissing(true)}
        aria-label={`${dance.name} reference video`}
      />
      {(missing || !src) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-br from-bg-card to-black p-2 text-center">
          <div className="text-[10px] font-bold uppercase tracking-widest text-accent">
            no video
          </div>
          <div className="text-[10px] text-text-muted leading-tight mt-1">
            placeholder
          </div>
        </div>
      )}
    </div>
  );
}
