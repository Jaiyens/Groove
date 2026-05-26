'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

type NavItem = {
  href: string;
  label: string;
  icon: 'library' | 'progress' | 'profile';
};

const ITEMS: readonly NavItem[] = [
  { href: '/', label: 'Library', icon: 'library' },
  { href: '/progress', label: 'Skills', icon: 'progress' },
  { href: '/profile', label: 'Profile', icon: 'profile' },
] as const;

function Icon({ kind, active }: { kind: NavItem['icon']; active: boolean }) {
  const color = active ? 'currentColor' : '#A39B95';
  const common = {
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: color,
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (kind) {
    case 'library':
      return (
        <svg {...common} aria-hidden>
          <path d="M4 4h6v16H4zM14 4h6v16h-6zM10 9h4M10 14h4" />
        </svg>
      );
    case 'progress':
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

export default function CreamBottomNav() {
  const pathname = usePathname() || '/';
  return (
    <nav className="flex h-[calc(64px+env(safe-area-inset-bottom))] shrink-0 items-center justify-around border-t border-ink/8 bg-cream/95 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur">
      {ITEMS.map((item) => {
        const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
        return (
          <Link
            key={item.label}
            href={item.href}
            className={`flex flex-col items-center gap-1 px-3 py-1 ${
              active ? 'text-coral' : 'text-ink-dim'
            }`}
            aria-current={active ? 'page' : undefined}
          >
            <Icon kind={item.icon} active={active} />
            <span className="text-[10px] font-semibold uppercase tracking-wide">
              {item.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
