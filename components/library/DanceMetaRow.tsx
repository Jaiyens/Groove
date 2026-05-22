import {
  formatDanceDuration,
  type DanceDifficulty,
  type DanceListItem,
} from '@/lib/dances/types';

interface DanceMetaRowProps {
  dance: Pick<DanceListItem, 'difficulty' | 'durationSeconds' | 'chunkCount'>;
  className?: string;
  showChunkCount?: boolean;
}

const DIFFICULTY_DOT: Record<DanceDifficulty, string> = {
  easy: 'bg-accent-green',
  medium: 'bg-accent-amber',
  hard: 'bg-coral',
};

export default function DanceMetaRow({
  dance,
  className = '',
  showChunkCount = true,
}: DanceMetaRowProps) {
  return (
    <div
      className={`flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] font-medium lowercase leading-none text-ink-muted ${className}`}
    >
      <span className="inline-flex items-center gap-1.5">
        <span
          aria-hidden
          className={`h-2 w-2 rounded-full ${DIFFICULTY_DOT[dance.difficulty]}`}
        />
        <span>{dance.difficulty}</span>
      </span>
      <span aria-hidden>·</span>
      <span>{formatDanceDuration(dance.durationSeconds)}</span>
      {showChunkCount && (
        <>
          <span aria-hidden>·</span>
          <span>
            {dance.chunkCount} {dance.chunkCount === 1 ? 'chunk' : 'chunks'}
          </span>
        </>
      )}
    </div>
  );
}
