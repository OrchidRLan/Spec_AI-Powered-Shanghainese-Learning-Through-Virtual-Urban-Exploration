import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inspectTeachingWav, validateAudioAssets, validateDeployment } from './validate-deployment.mjs';
import { deploymentMetadata, deploymentSource, verifyDeploymentOutput } from './build-deployment.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = mkdtempSync(join(tmpdir(), 'deployment-content-'));
after(() => rmSync(fixture, { recursive: true, force: true }));
cpSync(join(repo, 'content'), join(fixture, 'content'), { recursive: true });
cpSync(join(repo, 'frontend/public/audio'), join(fixture, 'frontend/public/audio'), { recursive: true });
const pack = JSON.parse(readFileSync(join(fixture, 'content/batch-a.json')));
for (const source of pack.sources) {
  const path = join(fixture, source.path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'Fixture source reference.');
}
const validation = validateDeployment({ root: fixture });
function change(path, edit, assertion) {
  const full = join(fixture, path), original = readFileSync(full);
  try {
    const value = JSON.parse(original);
    edit(value);
    writeFileSync(full, JSON.stringify(value));
    const result = validateDeployment({ root: fixture });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), assertion);
  } finally { writeFileSync(full, original); }
}

test('the complete real deployment accepts pending drafts without approving them', () => {
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  assert.equal(validation.productionApproved, false);
  assert.equal(validation.reviewStatus, 'pending');
  assert.equal(validation.networkCalls, 0);
  assert.equal(validation.audio.files.length, 64);
  assert.deepEqual(validation.audio.manifests.map(manifest => manifest.clips), [20, 20, 6, 36]);
});

test('missing R2 coverage and changed text are rejected before deployment', () => {
  change('content/audio-review-r2.json', data => data.clips.pop(), /coverage|audio does not match/);
  change('content/audio-review-r2.json', data => data.clips[0].text = 'Changed sentence', /text\/version\/reading mismatch|audio does not match/);
});

test('BC playback metadata must match its real audio and exact reading revision', () => {
  for (const [field, value, error] of [
    ['durationMs', 1, /audio metadata mismatch/], ['sampleRate', 1, /audio metadata mismatch/],
    ['pronunciationVersion', 'wrong-version', /text\/version\/reading mismatch/],
    ['speed', 'slow', /pending listening review/], ['generationId', 'f'.repeat(64), /generation identity mismatch/],
  ]) change('content/audio-review-bc.json', data => { data.clips[0][field] = value; }, error);
});

test('fake approvals and provenance changes cannot bypass the deployment gate', () => {
  change('content/batch-a.json', data => { data.expressions[0].review.language = 'approved'; }, /requires 2 independent current approval/);
  change('content/audio-review-bc.json', data => { data.clips[0].listeningReview = 'approved'; }, /pending/);
  change('content/audio-review-r2.json', data => { data.clips[0].generationConfig.model = 'replacement'; }, /generation provenance mismatch/);
  change('content/audio-review-r2.json', data => { data.clips[0].reusedFrom.sha256 = 'f'.repeat(64); }, /reuse source mismatch/);
});

test('frozen content and source manifest hashes are enforced', () => {
  change('content/audio-review-bc.json', data => { data.sourceManifestsSha256 = 'f'.repeat(64); }, /source audio manifest hashes changed/);
  change('content/audio-review-r2.json', data => { data.sourceInputSha256 = 'f'.repeat(64); }, /source text\/notation hash changed/);
  change('content/audio-review-r2.json', data => { data.productionApprovalSha256 = 'f'.repeat(64); }, /production approval state changed/);
});

const originalClip = JSON.parse(readFileSync(join(repo, 'content/audio-review-r2.json'))).clips[0];
const audioBytes = readFileSync(join(repo, 'frontend/public', originalClip.file));
test('strict WAV inspection rejects truncated PCM, wrong chunk sizes, and non-PCM audio', () => {
  for (const edit of [
    bytes => bytes.subarray(0, bytes.length - 2),
    bytes => { bytes.writeUInt32LE(bytes.length + 100, 40); return bytes; },
    bytes => { bytes.writeUInt16LE(3, 20); return bytes; },
    bytes => { bytes.writeUInt32LE(1, 28); return bytes; },
    bytes => Buffer.concat([bytes.subarray(0, 12), bytes.subarray(36), bytes.subarray(12, 36)]),
  ]) assert.throws(() => inspectTeachingWav(edit(Buffer.from(audioBytes))), /WAV/);
});

test('a corrupt audio file is rejected even when its checksum is updated', () => {
  const assetRoot = join(fixture, 'bad-audio'), path = join(assetRoot, originalClip.file);
  mkdirSync(dirname(path), { recursive: true });
  const corrupt = Buffer.from(audioBytes);
  corrupt.writeUInt32LE(corrupt.length + 100, 40);
  const wrongChunkOrder = Buffer.concat([audioBytes.subarray(0, 12), audioBytes.subarray(36), audioBytes.subarray(12, 36)]);
  for (const bytes of [corrupt, wrongChunkOrder]) {
    writeFileSync(path, bytes);
    const result = validateAudioAssets([{ ...originalClip, sha256: createHash('sha256').update(bytes).digest('hex') }], { assetRoot });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /WAV/);
  }
});

test('missing files and asset symlinks outside the public directory are rejected', () => {
  const assetRoot = join(fixture, 'escaped-audio'), path = join(assetRoot, originalClip.file);
  mkdirSync(dirname(path), { recursive: true });
  assert.equal(validateAudioAssets([originalClip], { assetRoot }).ok, false);
  symlinkSync(join(repo, 'frontend/public', originalClip.file), path);
  assert.match(validateAudioAssets([originalClip], { assetRoot }).errors.join('\n'), /inside its asset directory/);
});

test('the emitted build must contain byte-identical audio, not just a valid source tree', () => {
  const output = join(fixture, 'output');
  mkdirSync(output);
  writeFileSync(join(output, 'index.html'), '<!doctype html>');
  const report = { ...validation, audio: { ...validation.audio, files: [validation.audio.files[0]] } };
  assert.throws(() => verifyDeploymentOutput(report, output));
  const asset = report.audio.files[0], target = join(output, asset.file);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(repo, 'frontend/public', asset.file), target);
  assert.doesNotThrow(() => verifyDeploymentOutput(report, output));
  writeFileSync(target, 'corrupted build output');
  assert.throws(() => verifyDeploymentOutput(report, output), /differs from validated source/);
});

test('the public build record carries pending state and a narrow allowlist of metadata', () => {
  const record = deploymentMetadata(validation, { commit: 'a'.repeat(40), dirty: false, builtAt: '2026-10-17T12:00:00Z', apiKey: 'NEVER_INCLUDE' });
  assert.equal(record.source.commit, 'a'.repeat(40));
  assert.equal(record.buildMode, 'deployment-pending-acceptance');
  assert.equal(record.productionApproved, false);
  assert.ok(!JSON.stringify(record).includes('NEVER_INCLUDE'));
  assert.throws(() => deploymentMetadata(validation, { commit: 'bad' }), /valid commit/);
  assert.throws(() => deploymentMetadata({ ...validation, ok: false }, { commit: null }), /Valid content/);
});

test('cloud source commits do not mislabel generated build files as source changes', () => {
  const commit = 'a'.repeat(40);
  for (const [provider, variable] of [['vercel', 'VERCEL_GIT_COMMIT_SHA'], ['render', 'RENDER_GIT_COMMIT']]) {
    const source = deploymentSource({ env: { [variable]: commit }, readGit: () => assert.fail('Cloud source must not use build-tree Git status.') });
    assert.deepEqual(deploymentMetadata(validation, source).source, { commit, provider, dirty: null });
  }
  for (const [stdout, dirty] of [['', false], [' M tracked-file\n', true], ['?? local-file\n', true]]) {
    assert.deepEqual(deploymentSource({ env: {}, readGit: args => ({ status: 0, stdout: args[0] === 'rev-parse' ? `${commit}\n` : stdout }) }),
      { commit, provider: 'git', dirty });
  }
  assert.deepEqual(deploymentSource({ env: {}, readGit: () => ({ status: 1, stdout: '' }) }), { commit: null, provider: 'git', dirty: null });
});

test('production validation remains blocked, and deployment accepts no bypass flag', () => {
  const production = spawnSync(process.execPath, ['scripts/validate-content.mjs', '--production'], { cwd: repo, encoding: 'utf8' });
  assert.equal(production.status, 1);
  assert.match(production.stdout, /Package has not been approved for production/);
  const bypass = spawnSync(process.execPath, ['scripts/validate-deployment.mjs', '--skip-review'], { cwd: repo, encoding: 'utf8' });
  assert.equal(bypass.status, 1);
  assert.match(bypass.stderr, /accepts no bypass flags/);
});
