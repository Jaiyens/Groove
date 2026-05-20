'use client';

import Link from 'next/link';

interface BackHomeButtonProps {
  className?: string;
  label?: string;
}

export default function BackHomeButton({ className = '', label = 'Home' }: BackHomeButtonProps) {
  return (
    <Link
      href="/"
      aria-label="Back to home"
      className={`flex shrink-0 items-center gap-1.5 rounded-full bg-black/70 px-3 py-2 ring-1 ring-white/15 text-white backdrop-blur-sm active:scale-95 ${className}`}
    >
      <svg
        width={16}
        height={16}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M15 18l-6-6 6-6" />
      </svg>
      <span className="text-sm font-semibold">{label}</span>
    </Link>
  );
}
