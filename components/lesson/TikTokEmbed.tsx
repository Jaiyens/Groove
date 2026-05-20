'use client';

// Official TikTok embed iframe. We extract the video id from the user-
// submitted URL so short links (vm.tiktok.com) won't work directly — the
// worker stores the resolved canonical URL, so by the time we reach the
// results screen the id is recoverable.

import { useMemo } from 'react';
import { embedUrlFor, extractVideoId } from '@/lib/tiktok/embed';

interface TikTokEmbedProps {
  tiktokUrl: string;
}

export default function TikTokEmbed({ tiktokUrl }: TikTokEmbedProps) {
  const videoId = useMemo(() => extractVideoId(tiktokUrl), [tiktokUrl]);
  if (!videoId) {
    return (
      <a
        href={tiktokUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="block rounded-2xl bg-cream-card px-4 py-3 text-center text-sm font-semibold text-coral shadow-soft"
      >
        watch the original on TikTok ↗
      </a>
    );
  }
  return (
    <div className="overflow-hidden rounded-2xl bg-cream-card shadow-soft">
      <div className="aspect-[9/16] w-full">
        <iframe
          src={embedUrlFor(videoId)}
          title="Original TikTok"
          className="h-full w-full border-0"
          allow="encrypted-media; fullscreen"
          allowFullScreen
        />
      </div>
    </div>
  );
}
