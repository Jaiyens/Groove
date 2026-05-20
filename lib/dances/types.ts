// Dance fixture + resolved view.
//
// A DanceFixture is the minimal blob hardcoded in lib/dances/fixtures.ts —
// the editorial metadata that doesn't belong in the knowledge graph (display
// name, artist credit, video file path). Everything pedagogical (bpm,
// duration, required_skills, skill_weights) lives on the routine node in
// the knowledge graph and is merged in at resolve time.
//
// The Dance type used by UI components is the resolved shape.

export interface DanceFixture {
  // Must equal a Layer 6 routine node id in knowledge_graph.json.
  id: string;
  name: string;
  artist: string;
  video_url: string;
}

export interface Dance extends DanceFixture {
  bpm: number;
  duration_seconds: number;
  required_skills: string[];
  skill_weights: Record<string, number>;
}

export type DanceMetadata = Omit<Dance, 'video_url'>;
