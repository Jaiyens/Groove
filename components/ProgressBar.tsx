'use client';

interface ProgressBarProps {
  progress: number; // 0..1
  // Optional total beat count for tickmarks.
  beatCount?: number;
}

export default function ProgressBar({ progress, beatCount }: ProgressBarProps) {
  const p = Math.max(0, Math.min(1, progress));
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/10">
      <div
        className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-accent to-accent-cyan"
        style={{ width: `${p * 100}%` }}
      />
      {beatCount && beatCount > 0 && beatCount < 32 && (
        <div className="pointer-events-none absolute inset-0 flex">
          {Array.from({ length: beatCount }).map((_, i) => (
            <div
              key={i}
              className="flex-1 border-r border-white/10 last:border-0"
            />
          ))}
        </div>
      )}
    </div>
  );
}
