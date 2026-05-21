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
  video_url: string | null;
  audio_url: string | null;
  chunks_json: ChunkBoundary[] | null;
  required_skills: string[] | null;
  skill_weights: Record<string, number> | null;
  submitted_by_session_id: string | null;
  view_count: number;
  low_quality: boolean;
  audio_start_offset_ms: number;
  // Phase 3 multi-person fields. Optional so older rows without these
  // columns still parse.
  dancer_count?: number;
  auto_selected_person_id?: string | null;
  requires_dancer_pick?: boolean;
  person_thumbnails?: Record<string, string> | null;
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
//
// `video_url` is the original TikTok mp4 (worker uploads it to the `videos`
// bucket). Mode A plays this as the reference (top half of the duet view).
// `skeleton_video_url` is the worker-rendered skeleton mp4 — kept around as
// an opt-in overlay for the "show skeleton" toggle in Mode A; not the
// primary reference any more. May be null for legacy rows.
// `audio_url` is used by Mode B / C where the reference video is unmounted
// and only the soundtrack plays.
export interface Dance {
  id: string;
  name: string;
  artist: string;
  video_url: string | null;
  skeleton_video_url: string | null;
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
