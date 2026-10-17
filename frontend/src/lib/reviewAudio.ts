import manifest from '../../../content/audio-review-r2.json';
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
    && /^\/audio\/review-r[12]\/[A-Za-z0-9_-]+\.wav$/.test(clip.file)
    && clip.durationMs > 0);
}
