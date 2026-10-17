import manifest from '../../../content/audio-review-r2.json';
import confirmationManifest from '../../../content/audio-review-r4.json';
import type { LearningEntry } from '../components/LearningText';

type ReviewClip = {
  id: string; textId: string; textVersion: string; text: string;
  file: string; durationMs: number; status: string; reviewStatus: string;
  generationId: string; pronunciation: string | null; pronunciationVersion: string;
  purpose: string; speed: string; listeningReview: string;
};

/** Never play a draft belonging to a different sentence or text revision. */
export function reviewClipFor(entry: LearningEntry): ReviewClip | undefined {
  const clips = [...manifest.clips, ...confirmationManifest.clips] as ReviewClip[];
  return clips.find(clip => clip.id === `${entry.id}.normal`
    && clip.textId === entry.id && clip.textVersion === entry.version
    && clip.text === entry.hanzi && clip.status === 'generated'
    && clip.pronunciation === entry.pronunciation && clip.pronunciationVersion === entry.version
    && clip.reviewStatus === 'pending' && clip.listeningReview === 'pending'
    && clip.purpose === 'review-draft' && clip.speed === 'normal'
    && /^[a-f0-9]{64}$/.test(clip.generationId)
    && /^\/audio\/review-r[124]\/[a-f0-9]{64}\.wav$/.test(clip.file)
    && clip.file.endsWith(`/${clip.generationId}.wav`)
    && clip.durationMs > 0);
}
