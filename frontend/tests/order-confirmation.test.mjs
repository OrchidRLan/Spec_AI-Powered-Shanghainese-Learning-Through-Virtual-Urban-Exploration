import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transformWithOxc } from 'vite';
import { alignReading } from '../src/lib/readingAlignment.ts';

const readJson = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const confirmationContent = await readJson('../../content/nanxiang-confirmations-r4.json');
const manifest = await readJson('../../content/audio-review-r2.json');
const base = await readJson('../../content/batch-a.json');
const snapshot = await readJson('../../content/versions/batch-a-r2.2026-10-17.v1.json');
const executable = (await Promise.all(['orderConfirmation.ts', 'reviewAudio.ts'].map(async file => {
  const source = await readFile(new URL(`../src/lib/${file}`, import.meta.url), 'utf8');
  const transformed = await transformWithOxc(source, file);
  return transformed.code.replace(/^import\b[\s\S]*?;\n/gm, '').replace(/export (?=function )/g, '');
}))).join('\n');

// Synthetic matcher records only; no fake sounds or approvals enter the repo.
const clipFor = entry => ({
  id: `${entry.id}.normal`, textId: entry.id, textVersion: entry.version, text: entry.hanzi,
  pronunciation: entry.pronunciation, pronunciationVersion: entry.version,
  file: `/audio/review-r4/${'a'.repeat(64)}.wav`, generationId: 'a'.repeat(64), durationMs: 1000,
  status: 'generated', reviewStatus: 'pending', listeningReview: 'pending', purpose: 'review-draft', speed: 'normal',
});
function harness(clips = []) {
  const context = { confirmationContent, manifest, confirmationManifest: { clips } };
  vm.createContext(context);
  vm.runInContext(`${executable}\nglobalThis.subject = { orderConfirmationFor, reviewClipFor };`, context);
  return context.subject;
}
const order = (servings, takeaway) => ({ item: 'xiaolongbao', quantity: servings, normalized_servings: servings, takeaway });

test('each saved quantity and dining choice selects one unique complete confirmation', () => {
  const { orderConfirmationFor } = harness();
  const ids = new Set();
  for (const servings of [1, 2, 3]) for (const takeaway of [false, true]) {
    const result = orderConfirmationFor(order(servings, takeaway));
    assert.equal(result.id, `NX-CONFIRM-${servings}-${takeaway ? 'GO' : 'HERE'}`);
    assert.equal(result.hanzi, `${['一', '两', '三'][servings - 1]}份小笼馒头，${takeaway ? '打包带走' : '堂吃'}，对伐？`);
    assert.match(result.meaning.en, new RegExp(`${['One serving', 'Two servings', 'Three servings'][servings - 1]} of xiaolongbao ${takeaway ? 'to go' : 'for here'}`));
    ids.add(result.id);
  }
  assert.equal(ids.size, 6);
});

test('missing, unsupported or unnormalized saved orders never borrow another sentence', () => {
  const { orderConfirmationFor } = harness();
  for (const change of [{ item: null }, { item: 'tea' }, { takeaway: null }, { takeaway: 0 },
    { normalized_servings: null }, { normalized_servings: 0 }, { normalized_servings: 4 },
    { normalized_servings: 20 }, { normalized_servings: 1.5 }, { normalized_servings: '2' }]) {
    assert.equal(orderConfirmationFor({ ...order(2, false), ...change }), null, JSON.stringify(change));
  }
});

test('normalized servings are authoritative and raw quantity cannot guess a missing normalization', () => {
  const { orderConfirmationFor } = harness();
  assert.equal(orderConfirmationFor({ ...order(2, false), quantity: 12 }).id, 'NX-CONFIRM-2-HERE');
  assert.equal(orderConfirmationFor({ ...order(2, false), normalized_servings: null }), null);
});

test('changing the saved order selects the new variant without mutating prior material', () => {
  const { orderConfirmationFor } = harness();
  const saved = order(1, false);
  const original = orderConfirmationFor(saved);
  saved.normalized_servings = 3; saved.takeaway = true;
  assert.equal(orderConfirmationFor(saved).id, 'NX-CONFIRM-3-GO');
  assert.equal(original.hanzi, '一份小笼馒头，堂吃，对伐？');
});

test('all six drafts preserve source readings and punctuation stays aligned to the Hanzi', () => {
  const baseEntries = [...base.expressions, ...base.dialogues, ...base.supportTerms];
  const snapshotEntries = [...snapshot.expressions, ...snapshot.dialogues, ...snapshot.supportTerms];
  for (const entry of confirmationContent.dialogues) {
    assert.equal(entry.textKind, 'shanghainese-candidate');
    assert.equal(entry.review.language, 'pending');
    assert.equal(entry.review.pronunciation, 'pending');
    assert.equal(entry.review.audio, 'pending');
    assert.deepEqual(entry.review.recordIds, []);
    assert.equal(entry.segments.map(segment => segment.hanzi).join(''), entry.hanzi);
    for (const segment of entry.segments) {
      const aligned = alignReading(segment.hanzi, segment.pronunciation);
      assert(aligned, segment.id);
      assert.equal(aligned.map(unit => unit.hanzi).join(''), segment.hanzi);
      assert(!aligned.some(unit => /\d/u.test(unit.reading || '')));
    }
    for (const source of entry.sourceEntries) {
      const current = baseEntries.find(value => value.id === source.id);
      const historical = snapshotEntries.find(value => value.id === source.id);
      assert.equal(current.version, source.version);
      assert.deepEqual(current.segments, historical.segments);
    }
  }
});

test('a full confirmation uses only its matching complete-sentence clip', () => {
  for (const entry of confirmationContent.dialogues) {
    const expected = clipFor(entry);
    const { reviewClipFor } = harness([expected]);
    assert.equal(reviewClipFor(entry), expected);
    for (const other of confirmationContent.dialogues.filter(value => value.id !== entry.id)) {
      assert.equal(reviewClipFor(other), undefined);
    }
  }
});

test('missing new audio does not fall back to the old bare confirmation question', () => {
  const { reviewClipFor } = harness();
  assert(reviewClipFor(base.dialogues.find(entry => entry.id === 'NX-N09')));
  for (const entry of confirmationContent.dialogues) assert.equal(reviewClipFor(entry), undefined);
});

test('clip matching rejects stale text, version, notation, status, generation identity and paths', () => {
  const entry = confirmationContent.dialogues[0];
  const failures = [
    { text: '对伐？' }, { textId: 'NX-N09' }, { id: 'wrong.normal' }, { textVersion: 'old' },
    { pronunciation: 'different' }, { pronunciationVersion: 'old' }, { status: 'pending' },
    { reviewStatus: 'approved' }, { listeningReview: 'approved' }, { purpose: 'production' },
    { speed: 'slow' }, { durationMs: 0 }, { generationId: 'b'.repeat(64) },
    { file: '/audio/review-r4/../../private.wav' }, { file: `https://example.invalid/${'a'.repeat(64)}.wav` },
  ];
  for (const change of failures) {
    assert.equal(harness([{ ...clipFor(entry), ...change }]).reviewClipFor(entry), undefined, JSON.stringify(change));
  }
});

test('existing R1/R2 clips remain available with exact version and notation matches', () => {
  const { reviewClipFor } = harness();
  for (const entry of [...base.expressions, ...base.dialogues, ...base.supportTerms]) {
    const clip = reviewClipFor(entry);
    assert(clip, entry.id);
    assert.equal(clip.text, entry.hanzi);
    assert.match(clip.file, /^\/audio\/review-r[12]\//);
  }
});
