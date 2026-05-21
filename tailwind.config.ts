import type { Config } from 'tailwindcss';

// Direction 3 palette — off-white with electric hot-pink accents. The token
// names are kept stable from the previous "cream / coral" pass so existing
// markup keeps working; only the color VALUES change. See SPECK.md Phase 2.
//
// `cream` is now an off-white surface family.
// `coral` is now the hot-pink accent (used sparingly per the spec rules).
// `ink` is near-black text.
// `accent.green / amber / red` map onto the spec's success / warning / danger.

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Dark theme — camera screens (Mode A duet, Mode B, Mode C) stay
        // dark because skeleton overlays and reference video contrast need
        // black behind them. Direction 3 doesn't apply to those.
        bg: {
          DEFAULT: '#000000',
          elevated: '#0f0f10',
          card: '#161618',
        },
        text: {
          DEFAULT: '#ffffff',
          muted: '#9b9ba1',
          dim: '#5a5a62',
        },

        // Direction 3 light palette. Tokens are reused under their
        // "cream / ink / coral / slate" names — only the values change.
        cream: {
          DEFAULT: '#F8F8F6', // --bg: off-white background
          deep:    '#E5E5E1', // --border: warm light gray
          card:    '#FFFFFF', // --surface: cards, modals
        },
        ink: {
          DEFAULT: '#0A0A0A', // --text-primary: near-black
          muted:   '#6B6B6B', // --text-secondary
          dim:     '#A8A8A6', // --text-tertiary
        },
        coral: {
          DEFAULT: '#FF3E7F', // --accent: hot pink — used sparingly
          deep:    '#D1305F', // --accent-hover
          soft:    '#FFE0EB', // a very faint pink for badge backgrounds
        },
        // Kept for any leftover secondary references; mapped to neutral gray
        // so it visually disappears unless something needs deliberate
        // re-styling.
        slate: {
          DEFAULT: '#6B6B6B',
          soft:    '#E5E5E1',
        },

        // Score / status colors — match SPECK Phase 2 success/warning/danger.
        accent: {
          DEFAULT: '#FF3E7F', // hot pink, same as `coral` above
          cyan:    '#25f4ee', // unchanged — used only for the dark-mode skeleton overlay
          green:   '#00C26B', // --success
          amber:   '#FFB800', // --warning
          red:     '#FF3E3E', // --danger
        },
      },
      fontFamily: {
        // Everything resolves to Inter per SPECK §Phase 2 typography rules.
        // `font-serif` is kept as a class so existing markup compiles but
        // resolves to the same Inter stack — there is no more Fraunces /
        // Georgia / DM Serif Display fallback in the build.
        sans:    ['var(--font-inter)', 'Inter', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['var(--font-inter)', 'Inter', 'system-ui', 'sans-serif'],
        serif:   ['var(--font-inter)', 'Inter', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        // Lighter, less brown shadow than the cream-era version.
        soft: '0 1px 2px rgba(10, 10, 10, 0.04), 0 4px 16px rgba(10, 10, 10, 0.06)',
        lift: '0 4px 24px rgba(10, 10, 10, 0.10)',
      },
      maxWidth: {
        phone: '430px',
      },
      borderRadius: {
        phone: '46px',
      },
    },
  },
  plugins: [],
};

export default config;
