// Reference dance fixtures. These point to media files in /public/data/
// and to required_skills IDs that exist in the knowledge graph.

export interface Dance {
  id: string;
  name: string;
  artist: string;
  duration_seconds: number;
  bpm: number;
  video_url: string;
  required_skills: string[]; // skill ids in the knowledge graph
}

export type DanceMetadata = Omit<Dance, 'video_url'>;
