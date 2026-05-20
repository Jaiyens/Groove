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
    <div
      role="radiogroup"
      aria-label="Playback speed"
      className={`flex items-center gap-0.5 rounded-full bg-black/60 p-0.5 ring-1 ring-white/15 ${className}`}
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
            className={`min-w-[42px] rounded-full px-2.5 py-1 text-[11px] font-bold tabular-nums transition-colors ${
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
