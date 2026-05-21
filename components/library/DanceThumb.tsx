// Themable rounded thumbnail with text-fallback when no image is set.

import type { DanceListItem } from '@/lib/dances/types';

interface DanceThumbProps {
  dance: Pick<DanceListItem, 'title' | 'thumbnail_url'>;
  className?: string;
  rounded?: 'lg' | 'xl' | '2xl' | '3xl';
}

const ROUNDED = {
  lg: 'rounded-lg',
  xl: 'rounded-xl',
  '2xl': 'rounded-2xl',
  '3xl': 'rounded-3xl',
};

export default function DanceThumb({ dance, className = '', rounded = '2xl' }: DanceThumbProps) {
  const radius = ROUNDED[rounded];
  if (dance.thumbnail_url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={dance.thumbnail_url}
        alt={dance.title ?? ''}
        className={`${radius} object-cover ${className}`}
      />
    );
  }
  const letter = (dance.title ?? '?').trim().charAt(0).toUpperCase() || '?';
  return (
    <div
      className={`${radius} flex items-center justify-center bg-gradient-to-br from-cream-deep via-cream to-cream-card text-3xl font-medium text-ink ${className}`}
      aria-hidden
    >
      {letter}
    </div>
  );
}
