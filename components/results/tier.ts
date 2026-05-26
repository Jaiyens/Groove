// Shared tier mapping for the results sections. Keep the thresholds
// here so the carousel cards all agree on what "solid" vs "almost"
// means.

export function tierLabelFor(score: number): string {
  if (score >= 90) return 'groovy';
  if (score >= 75) return 'solid';
  if (score >= 60) return 'almost';
  if (score >= 40) return 'warming up';
  return 'just started';
}

export function tierColorFor(score: number): string {
  if (score >= 90) return 'text-accent-green';
  if (score >= 75) return 'text-ink';
  if (score >= 60) return 'text-ink';
  if (score >= 40) return 'text-accent-amber';
  return 'text-coral-deep';
}

export function tierBarFor(score: number): string {
  if (score >= 90) return 'bg-accent-green';
  if (score >= 75) return 'bg-ink';
  if (score >= 60) return 'bg-ink';
  if (score >= 40) return 'bg-accent-amber';
  return 'bg-coral-deep';
}

// SVG-fill counterpart of tierBarFor, kept as a separate function so
// Tailwind's content scanner sees the literal `fill-*` class names — a
// runtime string replace from `bg-*` would be invisible to the scanner.
export function tierFillFor(score: number): string {
  if (score >= 90) return 'fill-accent-green';
  if (score >= 75) return 'fill-ink';
  if (score >= 60) return 'fill-ink';
  if (score >= 40) return 'fill-accent-amber';
  return 'fill-coral-deep';
}
