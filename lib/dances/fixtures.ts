import type { Dance } from './types';

// Reference dance fixtures. IDs match skill IDs referenced in the stub graph.
// Real video files arrive tomorrow — for now, video_url points to placeholders
// in /public/data/reference_dances/. Failing to load gracefully degrades to a
// poster-only state in the practice screen.
export const DANCES: readonly Dance[] = [
  {
    id: 'fixture_apt',
    name: 'Apt. challenge',
    artist: 'Rosé',
    duration_seconds: 28,
    bpm: 149,
    video_url: '/data/reference_dances/apt.mp4',
    required_skills: ['stub_body_roll', 'stub_two_step', 'stub_shoulder_iso', 'stub_arm_wave'],
  },
  {
    id: 'fixture_espresso',
    name: 'Espresso',
    artist: 'Sabrina Carpenter',
    duration_seconds: 22,
    bpm: 103,
    video_url: '/data/reference_dances/espresso.mp4',
    required_skills: ['stub_two_step', 'stub_shoulder_iso'],
  },
  {
    id: 'fixture_renegade',
    name: 'Renegade',
    artist: 'K Camp',
    duration_seconds: 18,
    bpm: 126,
    video_url: '/data/reference_dances/renegade.mp4',
    required_skills: ['stub_arm_wave', 'stub_body_roll', 'stub_shoulder_iso'],
  },
] as const;

export function getDance(id: string): Dance | undefined {
  return DANCES.find((d) => d.id === id);
}
