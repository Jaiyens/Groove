'use client';

import { useState } from 'react';

interface VolumeControlProps {
  volume: number; // 0..1
  onChange: (v: number) => void;
  className?: string;
}

// Compact volume control: tap the speaker glyph to toggle mute, long-press /
// hold reveals the slider. Designed for the practice screen header where
// space is tight.
export default function VolumeControl({
  volume,
  onChange,
  className = '',
}: VolumeControlProps) {
  const [showSlider, setShowSlider] = useState(false);
  const [lastNonZero, setLastNonZero] = useState(volume > 0 ? volume : 0.7);

  const muted = volume <= 0.001;

  return (
    <div className={`relative flex items-center gap-2 ${className}`}>
      <button
        type="button"
        aria-label={muted ? 'Unmute' : 'Mute'}
        onClick={() => {
          if (muted) onChange(lastNonZero);
          else {
            setLastNonZero(volume);
            onChange(0);
          }
        }}
        onMouseEnter={() => setShowSlider(true)}
        onFocus={() => setShowSlider(true)}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white ring-1 ring-white/15 active:scale-95"
      >
        <SpeakerIcon level={muted ? 0 : volume < 0.5 ? 1 : 2} />
      </button>

      <div
        className={`overflow-hidden transition-[width] duration-200 ${
          showSlider ? 'w-24' : 'w-0'
        }`}
        onMouseLeave={() => setShowSlider(false)}
      >
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(volume * 100)}
          onChange={(e) => onChange(Number(e.target.value) / 100)}
          onBlur={() => setShowSlider(false)}
          aria-label="Volume"
          className="h-1 w-full appearance-none rounded-full bg-white/15 accent-accent"
        />
      </div>
    </div>
  );
}

function SpeakerIcon({ level }: { level: 0 | 1 | 2 }) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor" />
      {level === 0 && <path d="m17 9 4 6m0-6-4 6" />}
      {level >= 1 && <path d="M15.5 8.5a5 5 0 0 1 0 7" />}
      {level >= 2 && <path d="M18.5 5.5a9 9 0 0 1 0 13" />}
    </svg>
  );
}
