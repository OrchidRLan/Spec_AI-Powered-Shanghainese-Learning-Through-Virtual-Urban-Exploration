#!/usr/bin/env node
/** Read-only R3 reuse check. It cannot synthesize audio or change approval records. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { teachingTexts } from './validate-content.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const currentVersion = 'batch-a-r3.2026-10-17.v1';
const sourceVersion = 'batch-a-r2.2026-10-17.v1';

export function checkReviewReuse(pack, historical, manifest) {
  const errors = [];
  const check = (value, message) => { if (!value) errors.push(message); };
  check(pack.contentVersion === currentVersion, 'R3 content version required.');
  check(historical.contentVersion === sourceVersion, 'R2 source snapshot required.');
  check(pack.nanxiangTask?.audioReviewManifest === 'content/audio-review-r2.json', 'R3 must explicitly name its R2 audio source.');
  check(manifest.version === sourceVersion && manifest.purpose === 'review-draft' && manifest.reviewStatus === 'pending', 'R2 review draft source required.');
  const texts = teachingTexts(pack);
  const previous = new Map(teachingTexts(historical).map(entry => [entry.id, entry]));
  const textIds = new Set(texts.map(entry => entry.id));
  const clips = Array.isArray(manifest.clips) ? manifest.clips : [];
  check(new Set(clips.map(clip => clip.textId)).size === clips.length, 'Duplicate audio text bindings.');
  check(textIds.size === texts.length && textIds.size === previous.size
    && [...previous.keys()].every(id => textIds.has(id)), 'R3 must preserve each historical learning entry exactly once.');
  for (const entry of texts) {
    const before = previous.get(entry.id);
    const clip = clips.find(value => value.textId === entry.id);
    check(Boolean(before) && ['version', 'hanzi', 'pronunciation'].every(key => entry[key] === before[key])
      && JSON.stringify(entry.segments) === JSON.stringify(before.segments), `${entry.id}: reused learning text changed.`);
    check(Boolean(clip) && clip.id === entry.audio?.normal && clip.textId === entry.id
      && clip.textVersion === entry.version && clip.text === entry.hanzi
      && clip.textSha256 === createHash('sha256').update(entry.hanzi || '').digest('hex')
      && clip.pronunciation === entry.pronunciation && clip.pronunciationVersion === entry.version,
    `${entry.id}: audio does not match the current text and pronunciation revision.`);
    check(clip?.status === 'generated' && clip?.purpose === 'review-draft' && clip?.speed === 'normal'
      && clip?.reviewStatus === 'pending' && clip?.listeningReview === 'pending'
      && Array.isArray(clip?.reviewIds) && clip.reviewIds.length === 0,
    `${entry.id}: review draft status changed.`);
  }
  const currentIds = new Set([
    ...(pack.nanxiangTask?.questionIds || []), pack.nanxiangTask?.completionDialogueId,
    ...(pack.expressions || []).map(entry => entry.id), ...(pack.supportTerms || []).map(entry => entry.id),
  ]);
  const historicalIds = pack.nanxiangTask?.historicalOnlyDialogueIds || [];
  check(historicalIds.every(id => !currentIds.has(id)), 'Historical branch prompts cannot become current playback targets.');
  check([...currentIds].every(id => texts.some(entry => entry.id === id)), 'Unknown current playback target.');
  return {
    ok: errors.length === 0, errors, sourceVersion, currentVersion,
    matchedEntries: texts.length, currentPlaybackEntries: currentIds.size,
    historicalOnlyDialogueEntries: historicalIds.length,
    newAudioFiles: 0, networkCalls: 0, reviewStatus: 'pending',
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Validate the immutable manifest's complete R1/R2 provenance, file hashes and
  // WAV metadata before checking its compatibility with the current package.
  const sourceCheck = spawnSync(join(root, 'backend/.venv/bin/python'), ['scripts/speech-review-r2.py', 'check'], {
    cwd: root, encoding: 'utf8',
  });
  if (sourceCheck.status !== 0) {
    console.error(sourceCheck.stdout || sourceCheck.stderr || 'R2 audio source check failed.');
    process.exitCode = 1;
  } else {
    const read = path => JSON.parse(readFileSync(join(root, path), 'utf8'));
    const result = checkReviewReuse(read('content/batch-a.json'), read(`content/versions/${sourceVersion}.json`), read('content/audio-review-r2.json'));
    console.log(JSON.stringify({ status: result.ok ? 'passed' : 'failed', sourceAssetsVerified: true, ...result }, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  }
}
