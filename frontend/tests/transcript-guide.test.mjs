import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transcriptGuide } from '../src/lib/transcriptGuide.ts';

const content = JSON.parse(await readFile(new URL('../../content/batch-a.json', import.meta.url), 'utf8'));
const sources = [...content.dialogues, ...content.expressions, ...content.supportTerms];

test('known Shanghainese and Mandarin wording use the existing English meaning', () => {
  for (const source of sources) {
    assert.deepEqual(transcriptGuide(source.hanzi, 'en', sources)?.meanings, [source.meaning.en], source.id);
    assert.deepEqual(transcriptGuide(source.meaning.zh, 'en', sources)?.meanings, [source.meaning.en], source.id);
  }
});
test('presentation punctuation and spacing do not prevent an exact textbook lookup', () => {
  assert.deepEqual(transcriptGuide('  两 份！ ', 'en', sources)?.meanings, ['Two servings']);
  assert.deepEqual(transcriptGuide(' FOR HERE. ', 'zh', sources)?.meanings, ['堂吃']);
});
test('all separately spoken known clauses receive an explicit meaning for each clause', () => {
  const result = transcriptGuide('我要两份小笼馒头，打包带走。', 'en', sources);
  assert.equal(result?.kind, 'clauses');
  assert.deepEqual(result?.meanings, ['Two servings of xiaolongbao, please.', 'To go, please.']);
});
test('a known word group may be shown on its own without inferring an order', () => {
  assert.deepEqual(transcriptGuide('我要', 'en', sources)?.meanings, ['I would like']);
});
test('negation prefixes never become a positive textbook meaning', () => {
  for (const prefix of ['勿', '不', '不要', '弗', 'not ', 'do not ']) {
    assert.equal(transcriptGuide(`${prefix}打包带走`, 'en', sources), null, prefix);
  }
});
test('a negative or unknown clause prevents partial positive translation', () => {
  for (const phrase of ['不要，两份', '勿，打包带走', '两份，但是不要', '打包带走，我改变主意了']) {
    assert.equal(transcriptGuide(phrase, 'en', sources), null, phrase);
  }
});
test('substrings, extra quantities, and unseparated combinations are not guessed', () => {
  for (const phrase of ['我要两份小笼馒头三份', '请把打包带走去掉', '两份打包带走', '不是两份是三份', '-两份', '+两份']) {
    assert.equal(transcriptGuide(phrase, 'en', sources), null, phrase);
  }
});
test('empty and contradictory dictionary matches remain unavailable', () => {
  assert.equal(transcriptGuide('', 'en', sources), null);
  assert.equal(transcriptGuide('；，！？', 'en', sources), null);
  assert.equal(transcriptGuide('一样', 'en', [
    { id: 'first', hanzi: '一样', meaning: {zh:'一样',en:'One'} },
    { id: 'second', hanzi: '一样', meaning: {zh:'一样',en:'Two'} },
  ]), null);
});
