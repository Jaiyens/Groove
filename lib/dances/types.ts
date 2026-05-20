// Dance types.
//
// Two shapes:
// - `DanceRecord` is the backend row (matches the Supabase `dances` table).
// - `Dance` is the legacy in-app view used by practice routes; it adapts a
//   ready DanceRecord into the shape the existing scoring / chunking code
//   already understands (bpm, duration_seconds, required_skills,
//   skill_weights).

export type DanceStatus = 'queued' | 'processing' | 'ready' | 'failed';

export interface ChunkBoundary {
  index: number;
  startMs: number;
  endMs: number;
  skills: string[];
  label?: string;
}

// Full row as returned by the API (`GET /api/dances/:id`).
export interface DanceRecord {
  id: string;
  tiktok_url: string;
  title: string | null;
  creator_handle: string | null;
  duration_seconds: number | null;
  bpm: number | null;
  status: DanceStatus;
  error_message: string | null;
  thumbnail_url: string | null;
  pose_data_url: string | null;
  skeleton_video_url: string | null;
  audio_url: string | null;
  chunks_json: ChunkBoundary[] | null;
  required_skills: string[] | null;
  skill_weights: Record<string, number> | null;
  submitted_by_session_id: string | null;
  view_count: number;
  low_quality: boolean;
  audio_start_offset_ms: number;
  created_at: string;
  ready_at: string | null;
}

// Lightweight item used by the library list endpoint.
export interface DanceListItem {
  id: string;
  title: string | null;
  creator_handle: string | null;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  view_count: number;
  ready_at: string | null;
}

// Adapter shape consumed by the existing practice routes / scoring code.
// `video_url` historically pointed at a TikTok-style reference video; now it
// points at the worker-generated skeleton video. `audio_url` is new and is
// used by Mode B / C (camera full-screen, audio plays in background).
export interface Dance {
  id: string;
  name: string;
  artist: string;
  video_url: string;
  audio_url: string | null;
  thumbnail_url: string | null;
  tiktok_url: string;
  bpm: number;
  duration_seconds: number;
  required_skills: string[];
  skill_weights: Record<string, number>;
  pose_data_url: string | null;
  low_quality: boolean;
  audio_start_offset_ms: number;
}

// Backwards-compat shape kept around for any old import sites — most usage
// has moved to `Dance` above.
export interface DanceFixture {
  id: string;
  name: string;
  artist: string;
  video_url: string;
}

export type DanceMetadata = Omit<Dance, 'video_url'>;
