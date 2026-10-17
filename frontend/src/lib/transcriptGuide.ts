type Locale = 'zh' | 'en';
type Meaning = { zh: string; en: string };
export type GuideSource = {
  id: string;
  hanzi: string | null;
  meaning: Meaning;
  segments?: { id: string; hanzi: string; meaning?: Meaning }[];
};
export type TranscriptGuide = { kind: 'exact' | 'clauses'; meanings: string[]; sourceIds: string[] };

// Normalize presentation only. Negation, signs, numbers, and extra words stay intact.
function comparable(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\s，。！？；：,.!?;:"“”‘’「」『』、]/gu, '');
}

/** A textbook lookup, never an interpreter or an order-field extractor. */
export function transcriptGuide(text: string, locale: Locale, sources: readonly GuideSource[]): TranscriptGuide | null {
  const lookup = (clause: string): { meaning: string; id: string } | null => {
    const key = comparable(clause);
    if (!key) return null;
    const exact = sources.filter(source => [source.hanzi, source.meaning.zh, source.meaning.en].some(candidate => candidate && comparable(candidate) === key));
    const segments = sources.flatMap(source => source.segments || []).filter(segment => segment.meaning && [segment.hanzi, segment.meaning.zh, segment.meaning.en].some(candidate => comparable(candidate) === key));
    // Whole entries take precedence over the shorter segment's teaching gloss.
    const candidates = exact.length ? exact : segments;
    if (!candidates.length) return null;
    const meanings = new Set(candidates.map(candidate => comparable(candidate.meaning![locale])));
    if (meanings.size !== 1) return null;
    return { meaning: candidates[0].meaning![locale], id: candidates[0].id };
  };
  const exact = lookup(text);
  if (exact) return { kind: 'exact', meanings: [exact.meaning], sourceIds: [exact.id] };
  const clauses = text.split(/[，。！？；,!?;\n]+/u).map(clause => clause.trim()).filter(Boolean);
  if (clauses.length < 2 || clauses.length > 8) return null;
  const matches = clauses.map(lookup);
  // An unmatched clause might negate the others. Do not show a partial positive gloss.
  if (matches.some(match => !match)) return null;
  return {
    kind: 'clauses', meanings: matches.map(match => match!.meaning), sourceIds: matches.map(match => match!.id),
  };
}
