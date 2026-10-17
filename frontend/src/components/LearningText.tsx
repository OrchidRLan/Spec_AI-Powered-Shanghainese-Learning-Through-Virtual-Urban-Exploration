import type { Locale } from '../lib/api';

export type LearningEntry = {
  id: string;
  version: string;
  hanzi: string | null;
  pronunciation?: string | null;
  meaning: { zh: string; en: string };
  segments: { id: string; hanzi: string; pronunciation?: string | null }[];
};

/** A phrase keeps its reading aligned to each spoken word group in either UI language. */
export default function LearningText({ entry, locale, romanization = true, compact = false }: {
  entry: LearningEntry;
  locale: Locale;
  romanization?: boolean;
  compact?: boolean;
}) {
  const segments = entry.segments.length ? entry.segments : [{ id: entry.id, hanzi: entry.hanzi || '', pronunciation: entry.pronunciation }];
  return <span className={`learning-text ${compact ? 'learning-text-compact' : ''}`}>
    <span className="learning-segments" lang="wuu">
      {segments.map(segment => <span className="learning-segment" key={segment.id}>
        {romanization && segment.pronunciation && <span className="learning-reading">{segment.pronunciation}</span>}
        <span className="learning-hanzi">{segment.hanzi}</span>
      </span>)}
    </span>
    <span className="learning-meaning" lang={locale === 'zh' ? 'zh-CN' : 'en'}>{entry.meaning[locale]}</span>
  </span>;
}
