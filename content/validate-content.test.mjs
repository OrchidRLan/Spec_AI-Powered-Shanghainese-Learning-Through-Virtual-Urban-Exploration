import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateContent, teachingTexts, reviewSubjectSha256, packageSha256 } from '../scripts/validate-content.mjs';
import { checkReviewReuse } from '../scripts/check-audio-r3.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const draft = JSON.parse(readFileSync(join(repo, 'content/batch-a.json')));
const revision2 = JSON.parse(readFileSync(join(repo, 'content/versions/batch-a-r2.2026-10-17.v1.json')));
const reviewAudio = JSON.parse(readFileSync(join(repo, 'content/audio-review-r2.json')));
const empty = JSON.parse(readFileSync(join(repo, 'content/reviews.json')));
const root = mkdtempSync(join(tmpdir(), 'content-gate-synthetic-'));
after(() => rmSync(root, { recursive: true, force: true }));

// Synthetic test approvals never leave this temporary fixture or enter the ledger.
for (const source of draft.sources) {
  mkdirSync(dirname(join(root, source.path)), { recursive: true });
  writeFileSync(join(root, source.path), 'Synthetic specification fixture.');
}
const audio = Buffer.alloc(46);
audio.write('RIFF'); audio.writeUInt32LE(38, 4); audio.write('WAVEfmt ', 8);
audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28);
audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
audio.write('data', 36); audio.writeUInt32LE(2, 40);
writeFileSync(join(root, 'fixture.wav'), audio);
writeFileSync(join(root, 'not-audio.json'), '{"synthetic":true}');
const sha = createHash('sha256').update(audio).digest('hex');
const pack = structuredClone(draft);
const ledger = { schemaVersion: 1, reviewers: [], records: [], releaseApprovals: [] };
for (const id of ['synthetic-1', 'synthetic-2']) ledger.reviewers.push({
  id, displayName: 'SYNTHETIC TEST ONLY', fluentShanghainese: true,
  roles: ['language', 'pronunciation', 'approximation', 'audio', 'editorial', 'release'],
});
for (const text of teachingTexts(pack)) {
  if (!text.hanzi) {
    text.hanzi = 'fixture';
    text.segments = [{ id: `${text.id}-S01`, hanzi: 'fixture', meaning: { zh: 'fixture', en: 'fixture' }, pronunciation: null, approximateZh: null }];
  }
  text.textKind = 'reviewed-shanghainese';
  text.pronunciation = 'fixture'; text.approximateZh = 'fixture';
  text.pronunciationHelp = { zh: 'fixture', en: 'fixture' };
  for (const segment of text.segments) { segment.pronunciation = 'fixture'; segment.approximateZh = 'fixture'; }
  text.referenceReading = { file: 'fixture.wav', sha256: sha, speakerId: 'synthetic-1', recordedAt: '2026-10-17T12:00:00Z' };
  text.review = { status: 'approved', language: 'approved', pronunciation: 'approved', approximation: 'approved', audio: 'approved', recordIds: [] };
}
for (const clip of pack.audioClips) Object.assign(clip, { status: 'approved', file: 'fixture.wav', sha256: sha, durationMs: 0.125, source: 'human', deployment: 'human', voice: 'synthetic-1' });
let counter = 0;
const record = (item, stage, reviewerId = 'synthetic-1', clip = null) => {
  const review = { id: `SYNTHETIC-${++counter}`, contentId: item.id, contentVersion: item.version, stage,
    subjectSha256: reviewSubjectSha256(pack, item.id, stage, clip?.id), reviewerId, decision: 'approved',
    reviewedAt: '2026-10-17T13:00:00Z', notes: 'Synthetic test fixture, not actual review.', evidence: {} };
  if (stage === 'pronunciation') review.evidence.referenceAudio = 'fixture.wav';
  if (stage === 'approximation') review.evidence.trialNotes = 'Synthetic trial fixture only.';
  if (stage === 'audio') review.evidence = { clipId: clip.id, sha256: sha };
  ledger.records.push(review);
  (clip ? clip.reviewIds : item.copyReview?.recordIds ?? item.review.recordIds).push(review.id);
};
for (const text of teachingTexts(pack)) {
  record(text, 'language'); record(text, 'language', 'synthetic-2');
  record(text, 'pronunciation'); record(text, 'approximation');
  for (const clip of pack.audioClips.filter((item) => item.textId === text.id)) record(text, 'audio', 'synthetic-1', clip);
}
for (const item of [...pack.stations, pack.nanxiangTask]) { item.copyReview.status = 'approved'; record(item, 'editorial'); }
pack.status = 'approved'; pack.release.approved = true;
ledger.releaseApprovals.push({ id: 'SYNTHETIC-RELEASE', contentVersion: pack.contentVersion, packageSha256: packageSha256(pack), reviewerId: 'synthetic-1', decision: 'approved', reviewedAt: '2026-10-17T14:00:00Z', notes: 'Synthetic fixture; no live content approved.' });
const validate = (candidate = pack, reviews = ledger) => validateContent(candidate, reviews, { mode: 'production', root });
const clone = () => structuredClone(pack);

test('draft development accepts explicit pending', () => assert.equal(validateContent(draft, empty).ok, true));
test('revision 3 retains reviewable text and versioned approval boundaries', () => {
  const version = 'batch-a-r3.2026-10-17.v1';
  const changedIds = new Set(['NX-N04', 'NX-N05', 'NX-N06', 'NX-N09', 'NX-N10']);
  const expectedIds = [
    'E08', 'E09', 'E05',
    ...Array.from({ length: 12 }, (_, i) => `NX-N${String(i + 1).padStart(2, '0')}`),
    'NX-Q1', 'NX-Q2', 'NX-Q3', 'NX-MODE-HERE', 'NX-ITEM-XLB',
  ];
  const texts = teachingTexts(draft);
  assert.equal(draft.contentVersion, version);
  assert.deepEqual(texts.map((text) => text.id).sort(), expectedIds.sort());
  for (const text of texts) {
    assert.equal(text.version, changedIds.has(text.id) ? 'batch-a-r2.2026-10-17.v1' : 'batch-a-r1.2026-10-17.v1', text.id);
    assert.equal(text.textKind, 'shanghainese-candidate', text.id);
    assert.equal(typeof text.hanzi, 'string', text.id);
    assert.ok(text.hanzi.trim(), text.id);
    assert.equal(typeof text.pronunciation, 'string', text.id);
    assert.match(text.pronunciation, /[a-z]/i, text.id);
    assert.ok(text.segments.length > 0, text.id);
    assert.equal(text.segments.map((segment) => segment.hanzi).join(''), text.hanzi, text.id);
    for (const segment of text.segments) {
      assert.equal(typeof segment.pronunciation, 'string', segment.id);
      assert.match(segment.pronunciation, /[a-z]/i, segment.id);
      assert.ok(segment.meaning.zh.trim() && segment.meaning.en.trim(), segment.id);
    }
    assert.equal(text.review.status, 'draft', text.id);
    for (const stage of ['language', 'pronunciation', 'approximation', 'audio']) {
      assert.equal(text.review[stage], 'pending', `${text.id}:${stage}`);
    }
    assert.deepEqual(text.review.recordIds, [], text.id);
  }
  assert.equal(draft.release.approved, false);
  assert.deepEqual(empty, { schemaVersion: 1, reviewers: [], records: [], releaseApprovals: [] });
  assert.equal(draft.audioClips.length, 28);
  for (const clip of draft.audioClips) {
    assert.equal(clip.textVersion, texts.find(text => text.id === clip.textId).version, clip.id);
    assert.equal(clip.status, 'pending', clip.id);
    assert.equal(clip.file, null, clip.id);
    assert.deepEqual(clip.reviewIds, [], clip.id);
  }
});
test('revision 3 preserves R2 learning entries and validates the historical order definition', () => {
  assert.deepEqual(teachingTexts(draft), teachingTexts(revision2), 'No new wording, pronunciation or approvals are implied by the flow revision.');
  assert.equal(validateContent(revision2, empty).ok, true);
});
test('revision 3 cannot reintroduce branch questions or automatic advancement', () => {
  for (const mutate of [
    pack => { pack.nanxiangTask.questionIds.splice(2, 0, 'NX-N04'); },
    pack => { pack.nanxiangTask.historicalOnlyDialogueIds.pop(); },
    pack => { pack.nanxiangTask.allowAdHocQuestions = true; },
    pack => { pack.nanxiangTask.advancePolicy = 'automatic'; },
    pack => { pack.nanxiangTask.completionRequires = pack.nanxiangTask.completionRequires.filter(value => value !== 'explicit_continue'); },
    pack => { pack.nanxiangTask.units.push({ id: 'unknown', normalization: 'clarify' }); },
  ]) {
    const candidate = structuredClone(draft);
    mutate(candidate);
    assert.equal(validateContent(candidate, empty).ok, false);
  }
});
test('revision 3 reuses exact R2 review sounds without new assets or branch playback', () => {
  const result = checkReviewReuse(draft, revision2, reviewAudio);
  assert.deepEqual(result.errors, []);
  assert.equal(result.matchedEntries, 20);
  assert.equal(result.currentPlaybackEntries, 13);
  assert.equal(result.historicalOnlyDialogueEntries, 7);
  assert.equal(result.newAudioFiles, 0);
  assert.equal(result.networkCalls, 0);
});
test('audio reuse rejects changed pronunciation, source revision and target metadata', () => {
  for (const [field, value] of [['hanzi', 'changed'], ['pronunciation', 'changed'], ['version', 'changed']]) {
    const candidate = structuredClone(draft);
    candidate.expressions[0][field] = value;
    assert.equal(checkReviewReuse(candidate, revision2, reviewAudio).ok, false, field);
  }
  for (const [field, value] of [['textVersion', 'changed'], ['pronunciationVersion', 'changed'], ['pronunciation', 'changed'], ['id', 'changed.normal'], ['reviewStatus', 'approved']]) {
    const manifest = structuredClone(reviewAudio);
    manifest.clips[0][field] = value;
    assert.equal(checkReviewReuse(draft, revision2, manifest).ok, false, field);
  }
});
test('audio reuse rejects historical questions restored as current targets', () => {
  const candidate = structuredClone(draft);
  candidate.nanxiangTask.questionIds.push('NX-N04');
  assert.equal(checkReviewReuse(candidate, revision2, reviewAudio).ok, false);
});
test('standalone audio reuse check rejects duplicate historical entries hiding a missing one', () => {
  const candidate = structuredClone(draft);
  candidate.dialogues[candidate.dialogues.findIndex(entry => entry.id === 'NX-N04')]
    = structuredClone(candidate.dialogues.find(entry => entry.id === 'NX-N05'));
  assert.equal(checkReviewReuse(candidate, revision2, reviewAudio).ok, false);
});
test('revision 2 does not reuse audio for changed quantities or dining prompts', () => {
  const archive = JSON.parse(readFileSync(join(repo, 'content/versions/batch-a-r1.2026-10-17.v1.json')));
  const manifest = JSON.parse(readFileSync(join(repo, 'content/audio-review-r1.json')));
  const historicalTexts = teachingTexts(archive);
  const currentTexts = teachingTexts(draft);
  assert.equal(manifest.clips.length, 20);
  for (const clip of manifest.clips) {
    const historical = historicalTexts.find(text => text.id === clip.textId);
    assert.equal(clip.textVersion, historical.version);
    assert.equal(clip.text, historical.hanzi);
    assert.equal(clip.pronunciation, historical.pronunciation);
  }
  const available = currentTexts.filter(text => manifest.clips.some(clip => clip.textId === text.id && clip.textVersion === text.version && clip.text === text.hanzi));
  assert.equal(available.length, 15);
  for (const id of ['NX-Q1', 'NX-Q2', 'NX-Q3', 'NX-MODE-HERE', 'NX-ITEM-XLB', 'E09', 'E05']) {
    assert(available.some(text => text.id === id), `${id}: core speaking choices retain matching audio`);
  }
  for (const id of ['NX-N04', 'NX-N05', 'NX-N06', 'NX-N09', 'NX-N10']) {
    assert(!available.some(text => text.id === id), `${id}: changed text must not play R1 wording`);
  }
  assert.equal(validateContent(archive, empty).ok, true, 'the archived rule definition remains valid for historical sessions');
});
test('revision 2 rejects reinstating a fixed quantity or dining requirement', () => {
  for (const [field, value] of [['quantity', 2], ['normalizedServings', 2], ['takeaway', true]]) {
    const candidate = structuredClone(draft);
    candidate.nanxiangTask.target[field] = value;
    assert.equal(validateContent(candidate, empty).ok, false, field);
  }
  const candidate = structuredClone(draft);
  candidate.nanxiangTask.diningOptions = [true];
  assert.equal(validateContent(candidate, empty).ok, false);
});
test('draft production blocks', () => assert.equal(validateContent(draft, empty, { mode: 'production' }).ok, false));
test('flags alone cannot approve language', () => {
  const candidate = structuredClone(draft); candidate.expressions[0].review.language = 'approved';
  assert.equal(validateContent(candidate, empty).ok, false);
});
test('missing clip is rejected', () => {
  const candidate = structuredClone(draft); candidate.audioClips.pop();
  assert.equal(validateContent(candidate, empty).ok, false);
});
test('broken phrase grouping is rejected', () => {
  const candidate = structuredClone(draft); candidate.expressions[0].segments.pop();
  assert.equal(validateContent(candidate, empty).ok, false);
});
test('fully populated synthetic package can pass', () => assert.deepEqual(validate().errors, []));
test('one language reviewer is insufficient', () => {
  const reviews = structuredClone(ledger);
  reviews.records = reviews.records.filter((r) => !(r.contentId === 'E08' && r.stage === 'language' && r.reviewerId === 'synthetic-2'));
  assert.equal(validate(pack, reviews).ok, false);
});
test('two signatures by same reviewer are insufficient', () => {
  const reviews = structuredClone(ledger);
  reviews.records.find((r) => r.contentId === 'E08' && r.stage === 'language' && r.reviewerId === 'synthetic-2').reviewerId = 'synthetic-1';
  assert.equal(validate(pack, reviews).ok, false);
});
test('same-version content change invalidates approval', () => {
  const candidate = clone(); candidate.expressions[0].hanzi += 'x'; candidate.expressions[0].segments.at(-1).hanzi += 'x';
  assert.equal(validate(candidate).ok, false);
});
test('pending audio cannot enter production', () => {
  const candidate = clone(); candidate.audioClips[0].status = 'generated';
  assert.equal(validate(candidate).ok, false);
});
test('file checksum mismatch blocks release', () => {
  const candidate = clone(); candidate.audioClips[0].sha256 = '0'.repeat(64);
  assert.equal(validate(candidate).ok, false);
});
test('missing novice read-aloud evidence blocks', () => {
  const reviews = structuredClone(ledger); delete reviews.records.find((r) => r.stage === 'approximation').evidence.trialNotes;
  assert.equal(validate(pack, reviews).ok, false);
});
test('later changes requested blocks approval', () => {
  const reviews = structuredClone(ledger), review = structuredClone(reviews.records.find((r) => r.stage === 'language'));
  review.id = 'SYNTHETIC-REJECT'; review.decision = 'changes-requested'; review.reviewedAt = '2026-10-17T15:00:00Z'; reviews.records.push(review);
  assert.equal(validate(pack, reviews).ok, false);
});
test('historical version review does not block current package', () => {
  const reviews = structuredClone(ledger), review = structuredClone(reviews.records[0]);
  review.id = 'SYNTHETIC-OLD'; review.contentVersion = 'older-version'; review.subjectSha256 = '0'.repeat(64); reviews.records.push(review);
  assert.deepEqual(validate(pack, reviews).errors, []);
});
test('asset traversal is rejected', () => {
  const candidate = clone(); candidate.audioClips[0].file = '../fixture.wav';
  assert.equal(validate(candidate).ok, false);
});
test('stale audio text version rejected', () => {
  const candidate = clone(); candidate.audioClips[0].textVersion = 'older';
  assert.equal(validate(candidate).ok, false);
});
test('missing actual audio and reference files block', () => {
  const candidate = clone(); candidate.audioClips[0].file = 'missing.wav'; candidate.expressions[0].referenceReading.file = 'missing.wav';
  assert.equal(validate(candidate).ok, false);
});
test('wrong kind cannot remove the expression slow-audio requirement', () => {
  const candidate = structuredClone(draft); candidate.expressions[0].kind = 'dialogue'; delete candidate.expressions[0].audio.slow;
  candidate.audioClips = candidate.audioClips.filter((item) => item.id !== 'E08.slow');
  assert.equal(validateContent(candidate, empty).ok, false);
});
test('a non-audio file with a matching checksum is rejected', () => {
  const candidate = clone(); const clip = candidate.audioClips[0];
  clip.file = 'not-audio.json'; clip.sha256 = createHash('sha256').update(readFileSync(join(root, clip.file))).digest('hex');
  const result = validate(candidate);
  assert(result.errors.some((error) => error.includes('not a supported audio container')));
});
test('a wrong recorded audio duration is rejected', () => {
  const candidate = clone(); candidate.audioClips[0].durationMs = 12000;
  assert(validate(candidate).errors.some((error) => error.includes('duration does not match')));
});
test('a truncated WAV is rejected even when checksum matches', () => {
  const broken = Buffer.from(audio); broken.writeUInt32LE(1000, 40);
  writeFileSync(join(root, 'broken.wav'), broken);
  const candidate = clone(); candidate.audioClips[0].file = 'broken.wav'; candidate.audioClips[0].sha256 = createHash('sha256').update(broken).digest('hex');
  assert(validate(candidate).errors.some((error) => error.includes('truncated WAV chunk')));
});
