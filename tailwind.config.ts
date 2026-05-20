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
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['var(--font-display)', 'system-ui', 'sans-serif'],
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
