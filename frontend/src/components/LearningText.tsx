import type { Locale } from '../lib/api';
import { alignReading, displayRomanization } from '../lib/readingAlignment';

export type LearningEntry = {
  id: string;
  version: string;
  hanzi: string | null;
  pronunciation?: string | null;
  meaning: { zh: string; en: string };
  segments: { id: string; hanzi: string; pronunciation?: string | null }[];
};

/** Character/reading pairs stay together inside their existing teaching groups. */
export default function LearningText({ entry, locale, romanization = true, compact = false }: {
  entry: LearningEntry;
  locale: Locale;
  romanization?: boolean;
  compact?: boolean;
}) {
  const segments = entry.segments.length ? entry.segments : [{ id: entry.id, hanzi: entry.hanzi || '', pronunciation: entry.pronunciation }];
  return <span className={`learning-text ${compact ? 'learning-text-compact' : ''}`}>
    <span className="learning-segments" lang="wuu">
      {segments.map(segment => {
        const units = alignReading(segment.hanzi, segment.pronunciation);
        return <span className={`learning-segment${units ? ' learning-segment-aligned' : ''}`} key={segment.id}>
          {units ? units.map((unit, index) => unit.punctuation
            ? <span className="learning-hanzi learning-punctuation" key={index}>{unit.hanzi}</span>
            : <span className="learning-character" key={index}>
                {romanization && <span className="learning-reading">{unit.reading}</span>}
                <span className="learning-hanzi">{unit.hanzi}</span>
              </span>) : <>
              {romanization && segment.pronunciation && <span className="learning-reading">{displayRomanization(segment.pronunciation)}</span>}
              <span className="learning-hanzi">{segment.hanzi}</span>
            </>}
        </span>;
      })}
    </span>
    <span className="learning-meaning" lang={locale === 'zh' ? 'zh-CN' : 'en'}>{entry.meaning[locale]}</span>
  </span>;
}
