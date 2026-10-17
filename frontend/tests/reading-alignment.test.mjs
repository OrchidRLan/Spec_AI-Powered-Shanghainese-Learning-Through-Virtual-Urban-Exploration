import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { alignReading, displayRomanization } from '../src/lib/readingAlignment.ts';

const content = JSON.parse(await readFile(new URL('../../content/batch-a.json', import.meta.url), 'utf8'));

test('citation numbers are omitted from visible readings without changing unnumbered syllables', () => {
  assert.equal(displayRomanization('ngu6 iau5 / lian6 ven6 / te5 gheq'), 'ngu iau / lian ven / te gheq');
  assert.equal(displayRomanization('shiau5 lon6 moe6 deu6'), 'shiau lon moe deu');
});

test('punctuation occupies no syllable and does not shift later character readings', () => {
  assert.deepEqual(alignReading('侬好，要几份？', 'non6 hau5 iau5 ci5 ven6'), [
    { hanzi: '侬', reading: 'non', punctuation: false },
    { hanzi: '好', reading: 'hau', punctuation: false },
    { hanzi: '，', reading: null, punctuation: true },
    { hanzi: '要', reading: 'iau', punctuation: false },
    { hanzi: '几', reading: 'ci', punctuation: false },
    { hanzi: '份', reading: 'ven', punctuation: false },
    { hanzi: '？', reading: null, punctuation: true },
  ]);
});

test('unmatched or mixed-script groups fall back instead of assigning invented readings', () => {
  assert.equal(alignReading('小笼馒头', 'shiau5 lon6'), null);
  assert.equal(alignReading('两份', null), null);
  assert.equal(alignReading('2份', 'lian6 ven6'), null);
  assert.equal(alignReading('两份', 'lian6 / ven6'), null);
});

test('every current teaching group aligns without dropping Hanzi, punctuation or source tones', () => {
  for (const entry of [...content.expressions, ...content.dialogues, ...content.supportTerms]) {
    for (const segment of entry.segments) {
      const original = segment.pronunciation;
      const units = alignReading(segment.hanzi, original);
      assert(units, segment.id);
      assert.equal(units.map(unit => unit.hanzi).join(''), segment.hanzi, segment.id);
      assert(!units.some(unit => /\d/u.test(unit.reading || '')), segment.id);
      assert.equal(segment.pronunciation, original, segment.id);
      assert.match(segment.pronunciation, /\d/u, segment.id);
    }
  }
});
