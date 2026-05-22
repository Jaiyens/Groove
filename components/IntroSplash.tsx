'use client';

import { useEffect, useState } from 'react';

const INTRO_SEEN_KEY = 'groovy.intro_splash_seen.v1';
const INTRO_DURATION_MS = 3400;

export default function IntroSplash() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (window.sessionStorage.getItem(INTRO_SEEN_KEY) === '1') return;

    setVisible(true);
    window.sessionStorage.setItem(INTRO_SEEN_KEY, '1');
    const timeout = window.setTimeout(() => setVisible(false), INTRO_DURATION_MS);
    return () => window.clearTimeout(timeout);
  }, []);

  if (!visible) return null;

  return (
    <div
      className="intro-splash"
      role="img"
      aria-label="Groovy intro animation"
    >
      <div className="intro-pink-wash" aria-hidden />
      <div className="intro-orbit intro-orbit-one" aria-hidden />
      <div className="intro-orbit intro-orbit-two" aria-hidden />

      <div className="intro-logo-wrap">
        <div className="intro-logo" aria-hidden>
          <span className="intro-groov">groov</span>
          <svg
            className="intro-y"
            viewBox="0 0 78 118"
            focusable="false"
            aria-hidden
          >
            <path
              className="intro-y-path intro-y-path-top"
              d="M8 18 C20 38 29 50 39 52 C48 43 55 30 64 10"
              pathLength="1"
            />
            <path
              className="intro-y-path intro-y-path-loop"
              d="M39 52 C35 74 24 90 18 99 C8 114 44 118 57 97"
              pathLength="1"
            />
          </svg>
        </div>
        <svg
          className="intro-swoosh"
          viewBox="0 0 360 160"
          fill="none"
          aria-hidden
        >
          <path
            d="M42 116 C94 150 180 148 246 116 C303 88 318 44 276 34 C226 22 205 100 267 112 C305 118 332 96 342 72"
            pathLength="1"
          />
        </svg>
      </div>
    </div>
  );
}
