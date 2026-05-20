'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

type NavItem = {
  href: string;
  label: string;
  icon: 'home' | 'trophy' | 'stats' | 'profile';
};

const ITEMS: readonly NavItem[] = [
  { href: '/', label: 'Home', icon: 'home' },
  { href: '/#trophy', label: 'Trophy', icon: 'trophy' },
  { href: '/#stats', label: 'Stats', icon: 'stats' },
  { href: '/#profile', label: 'Profile', icon: 'profile' },
] as const;

function Icon({ kind, active }: { kind: NavItem['icon']; active: boolean }) {
  const stroke = active ? 'currentColor' : '#5a5a62';
  const fill = active ? 'currentColor' : 'none';
  const common = {
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill,
    stroke,
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (kind) {
    case 'home':
      return (
        <svg {...common} aria-hidden>
          <path d="M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1z" />
        </svg>
      );
    case 'trophy':
      return (
        <svg {...common} aria-hidden>
          <path d="M8 4h8v4a4 4 0 1 1-8 0z" />
          <path d="M4 5h4M16 5h4M9 14v3h6v-3M8 21h8" />
        </svg>
      );
    case 'stats':
      return (
        <svg {...common} aria-hidden>
          <path d="M4 19V8M10 19v-6M16 19V4M22 19H2" />
        </svg>
      );
    case 'profile':
      return (
        <svg {...common} aria-hidden>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21a8 8 0 0 1 16 0" />
        </svg>
      );
  }
}

export default function BottomNav() {
  const pathname = usePathname() || '/';
  return (
    <nav className="safe-bottom flex items-center justify-around border-t border-white/5 bg-black/80 backdrop-blur px-2 pt-2 pb-2">
      {ITEMS.map((item) => {
        const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
        return (
          <Link
            key={item.label}
            href={item.href}
            className={`flex flex-col items-center gap-1 px-3 py-1 ${
              active ? 'text-white' : 'text-text-dim'
            }`}
            aria-current={active ? 'page' : undefined}
          >
            <Icon kind={item.icon} active={active} />
            <span className="text-[10px] font-semibold tracking-wide uppercase">
              {item.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
