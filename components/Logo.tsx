'use client';

// SPECK polish §Fix 4: the Groovy wordmark.
//
// Why this looks the way it does:
//
//   Typeface
//     Bricolage Grotesque (700/800). It has squared corners, optical-size
//     responsiveness, and slightly off-axis terminals — reads as
//     "weird-but-readable", which is the energy we want for a TikTok
//     dance app aimed at teens. Inter and the other geometric sans
//     options read as a fintech wordmark; we deliberately avoid those.
//
//   Italic skew
//     -4° skew on every letter so the word leans forward. Combined with
//     the looping Y descender, the wordmark looks like it's mid-move.
//     We use `transform: skewX` rather than the font's italic axis so
//     we get a clean geometric lean without the soft strokes that
//     Bricolage's true italic introduces.
//
//   Playful Y
//     The final letter is an inline SVG path so only the Y gets a custom,
//     looping descender. The rest of the word stays clean and chunky.
//
//   Gradient fill
//     The top-to-bottom gradient runs from --coral (the brand pink) to
//     a lighter pink (~85% L). Subtle — it should read as a hot pink
//     wordmark first, then on a second look you notice the fade.
//
// Tweaks should happen in this file. The container handles size + skew,
// each <span> letter inherits the font + gradient, and the final Y gets
// the custom path on top.

interface LogoProps {
  // Sets the font-size on the container; everything else scales off em.
  className?: string;
  // The text content. Defaults to "groovy" (lowercase).
  // Override only if a marketing surface needs a different casing.
  children?: string;
}

function PlayfulY() {
  return (
    <svg
      className="wordmark-groov-y"
      aria-hidden
      viewBox="0 0 78 118"
    >
      <path
        d="M8 18 C20 38 29 50 39 52 C48 43 55 30 64 10"
        pathLength="1"
      />
      <path
        d="M39 52 C35 74 24 90 18 99 C8 114 44 118 57 97"
        pathLength="1"
      />
    </svg>
  );
}

export default function Logo({ className = '', children = 'groovy' }: LogoProps) {
  const label = children;
  const hasPlayfulY = label.toLowerCase().endsWith('y');
  const letters = hasPlayfulY ? label.slice(0, -1).split('') : label.split('');

  return (
    <span
      className={`wordmark-groov inline-block align-baseline leading-none ${className}`}
      aria-label={label}
    >
      {letters.map((ch, i) => (
        <span key={i} aria-hidden className="inline-block">
          {ch}
        </span>
      ))}
      {hasPlayfulY && <PlayfulY />}
    </span>
  );
}
