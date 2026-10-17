import manifest from '../../../content/audio-review-r1.json';
import type { LearningEntry } from '../components/LearningText';

type ReviewClip = {
  id: string; textId: string; textVersion: string; text: string;
  file: string; durationMs: number; status: string; reviewStatus: string;
};

/** Never play a draft belonging to a different sentence or text revision. */
export function reviewClipFor(entry: LearningEntry): ReviewClip | undefined {
  const clips = manifest.clips as ReviewClip[];
  return clips.find(clip => clip.textId === entry.id && clip.textVersion === entry.version
    && clip.text === entry.hanzi && clip.status === 'generated'
    && clip.file.startsWith('/audio/review-r1/') && clip.file.endsWith('.wav')
    && clip.durationMs > 0);
}
