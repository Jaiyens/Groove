import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
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
        accent: {
          DEFAULT: '#fe2c55',
          cyan: '#25f4ee',
          green: '#22c55e',
          amber: '#f59e0b',
          red: '#ef4444',
        },
        // Simply-style cream palette (Phase 3+)
        cream: {
          DEFAULT: '#FAF6F0',
          deep: '#F1EADD',
          card: '#FFFFFF',
        },
        ink: {
          DEFAULT: '#1A1714',
          muted: '#6E6660',
          dim: '#A39B95',
        },
        coral: {
          DEFAULT: '#E27A56',
          deep: '#C8633E',
          soft: '#F5C9B6',
        },
        slate: {
          DEFAULT: '#5B7F8C',
          soft: '#C8D5DA',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['var(--font-display)', 'system-ui', 'sans-serif'],
        serif: ['var(--font-display-serif)', 'Fraunces', 'DM Serif Display', 'Georgia', 'serif'],
      },
      boxShadow: {
        soft: '0 1px 2px rgba(26, 23, 20, 0.04), 0 4px 16px rgba(26, 23, 20, 0.06)',
        lift: '0 4px 24px rgba(26, 23, 20, 0.10)',
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
