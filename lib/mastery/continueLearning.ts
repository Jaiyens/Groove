import type { DanceListItem } from '@/lib/dances/types';

const STORAGE_KEY = 'groove.continueLearning.v1';
export const CONTINUE_LEARNING_EVENT = 'groove:continue-learning-updated';

export interface ContinueLearningEntry {
  danceId: string;
  title: string | null;
  displayName: string | null;
  creatorHandle: string | null;
  thumbnailUrl: string | null;
  totalChunks: number;
  currentChunkIndex: number;
  openedAt: number;
  updatedAt: number;
}

interface PersistShape {
  [danceId: string]: ContinueLearningEntry;
}

interface RecordContinueLearningInput {
  danceId: string;
  title: string | null;
  displayName: string | null;
  creatorHandle?: string | null;
  thumbnailUrl?: string | null;
  totalChunks: number;
  currentChunkIndex?: number;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

function readAll(): PersistShape {
  if (!isBrowser()) return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PersistShape;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(data: PersistShape): void {
  if (!isBrowser()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    window.dispatchEvent(new Event(CONTINUE_LEARNING_EVENT));
  } catch {
    // Best effort only; progress should never block the lesson flow.
  }
}

function clampChunkIndex(index: number, totalChunks: number): number {
  if (totalChunks <= 0) return 0;
  return Math.min(Math.max(0, Math.trunc(index)), totalChunks - 1);
}

export function recordContinueLearning(input: RecordContinueLearningInput): void {
  if (input.totalChunks <= 0) return;
  const all = readAll();
  const existing = all[input.danceId];
  const now = Date.now();
  const currentChunkIndex = clampChunkIndex(
    input.currentChunkIndex ?? existing?.currentChunkIndex ?? 0,
    input.totalChunks,
  );

  all[input.danceId] = {
    danceId: input.danceId,
    title: input.title,
    displayName: input.displayName,
    creatorHandle: input.creatorHandle ?? null,
    thumbnailUrl: input.thumbnailUrl ?? null,
    totalChunks: input.totalChunks,
    currentChunkIndex,
    openedAt: existing?.openedAt ?? now,
    updatedAt: now,
  };
  writeAll(all);
}

export function getContinueLearningEntries(): ContinueLearningEntry[] {
  return Object.values(readAll())
    .filter((entry) => entry.totalChunks > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function mergeContinueLearningEntry(
  entry: ContinueLearningEntry,
  dance?: DanceListItem,
): ContinueLearningEntry {
  if (!dance) return entry;
  return {
    ...entry,
    title: dance.title,
    displayName: dance.display_name,
    creatorHandle: dance.creator_handle,
    thumbnailUrl: dance.thumbnail_url,
  };
}
