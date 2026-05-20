// Adapt a backend DanceRecord into the in-app Dance shape used by the
// existing practice routes (Mode A / B / C, scoring, chunker).

import type { Dance, DanceRecord } from './types';

export function recordToDance(record: DanceRecord): Dance | null {
  if (record.status !== 'ready') return null;
  if (
    record.duration_seconds == null ||
    record.bpm == null ||
    !record.required_skills ||
    !record.skill_weights ||
    !record.skeleton_video_url
  ) {
    return null;
  }
  return {
    id: record.id,
    name: record.title ?? 'Untitled',
    artist: record.creator_handle ?? 'unknown',
    video_url: record.skeleton_video_url,
    audio_url: record.audio_url,
    thumbnail_url: record.thumbnail_url,
    tiktok_url: record.tiktok_url,
    bpm: record.bpm,
    duration_seconds: record.duration_seconds,
    required_skills: record.required_skills,
    skill_weights: record.skill_weights,
    pose_data_url: record.pose_data_url,
    low_quality: record.low_quality,
    audio_start_offset_ms: record.audio_start_offset_ms,
  };
}
