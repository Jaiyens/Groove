'use client';

interface SpeedToggleProps {
  rate: number;
  onChange: (rate: number) => void;
  options?: readonly number[];
  className?: string;
}

const DEFAULT_OPTIONS = [0.5, 0.75, 1] as const;

export default function SpeedToggle({
  rate,
  onChange,
  options = DEFAULT_OPTIONS,
  className = '',
}: SpeedToggleProps) {
  return (
    // spec.md §Fix 3: 44pt-tall segmented control so each speed
    // option meets the Apple HIG min tap target.
    <div
      role="radiogroup"
      aria-label="Playback speed"
      className={`flex h-11 items-center gap-0.5 rounded-full bg-black/60 p-1 ring-1 ring-white/15 ${className}`}
    >
      {options.map((opt) => {
        const active = Math.abs(rate - opt) < 0.001;
        return (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt)}
            className={`flex h-full min-w-[44px] items-center justify-center rounded-full px-3 text-xs font-bold tabular-nums transition-colors ${
              active
                ? 'bg-white text-black'
                : 'text-white/70 hover:text-white'
            }`}
          >
            {Math.round(opt * 100)}%
          </button>
        );
      })}
    </div>
  );
}
