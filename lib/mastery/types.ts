// Mastery store types. All persistable as JSON for localStorage / iOS UserDefaults.

export interface AttemptRecord {
  attempt_id: string;
  dance_id: string;
  timestamp_ms: number;
  overall_score: number; // 0..100
  per_skill_scores: Record<string, number>; // skill_id -> 0..100
}

export interface MasteryRecord {
  skill_id: string;
  mastery: number; // 0..1 EMA over attempts
  attempts: number;
  last_updated_ms: number;
}

export interface MasterySnapshot {
  version: 1;
  mastery: Record<string, MasteryRecord>; // skill_id -> record
  attempts: AttemptRecord[];               // ring-buffered, newest last
}
