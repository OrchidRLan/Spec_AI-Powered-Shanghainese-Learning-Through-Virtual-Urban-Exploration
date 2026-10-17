export type ReadingUnit = {
  hanzi: string;
  reading: string | null;
  punctuation: boolean;
};

/** Keep citation-tone metadata in content; the learner sees only the letters. */
export function displayRomanization(pronunciation: string): string {
  return pronunciation.replace(/(\p{L})\d+(?=$|[\s/.,!?;:'’—-])/gu, '$1');
}

/** Return null when a phrase cannot be aligned without inventing a correspondence. */
export function alignReading(hanzi: string, pronunciation?: string | null): ReadingUnit[] | null {
  if (!pronunciation?.trim()) return null;
  const characters = Array.from(hanzi);
  const spoken = characters.filter(character => /\p{Script=Han}/u.test(character));
  if (!spoken.length || characters.some(character => !/[\p{Script=Han}\p{P}\s]/u.test(character))) return null;
  const readings = displayRomanization(pronunciation).trim().split(/\s+/u);
  if (readings.length !== spoken.length || readings.some(reading => !/^\p{L}+(?:['’]\p{L}+)*$/u.test(reading))) return null;
  let index = 0;
  return characters.map(character => {
    const isSpoken = /\p{Script=Han}/u.test(character);
    return { hanzi: character, reading: isSpoken ? readings[index++] : null, punctuation: !isSpoken };
  });
}
