'use client';

// SPECK polish §Fix 4: the Groov wordmark.
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
//     the final V kicking up, the wordmark looks like it's mid-move.
//     We use `transform: skewX` rather than the font's italic axis so
//     we get a clean geometric lean without the soft strokes that
//     Bricolage's true italic introduces.
//
//   Kicked-up V
//     The final letter is rotated 12° to the right and bumped up a few
//     pixels so the right leg of the V juts above the baseline. This
//     is the visual "kick" the spec asks for. The rotation pivots on
//     the lower-left of the glyph so the kick lands above the baseline
//     instead of dropping below it.
//
//   Gradient fill
//     The top-to-bottom gradient runs from --coral (the brand pink) to
//     a lighter pink (~85% L). Subtle — it should read as a hot pink
//     wordmark first, then on a second look you notice the fade.
//
// Tweaks should happen in this file. The container handles size + skew,
// each <span> letter inherits the font + gradient, and the final V gets
// the kick on top.

interface LogoProps {
  // Sets the font-size on the container; everything else scales off em.
  className?: string;
  // The text content. Defaults to "groov" (lowercase, no Y — see spec).
  // Override only if a marketing surface needs a different casing.
  children?: string;
}

export default function Logo({ className = '', children = 'groov' }: LogoProps) {
  const letters = children.split('');
  const lastIdx = letters.length - 1;
  return (
    <span
      className={`wordmark-groov inline-block align-baseline leading-none ${className}`}
      aria-label={children}
    >
      {letters.map((ch, i) => (
        <span
          key={i}
          aria-hidden
          className={
            i === lastIdx
              ? 'wordmark-groov-kicker inline-block'
              : 'inline-block'
          }
        >
          {ch}
        </span>
      ))}
    </span>
  );
}
