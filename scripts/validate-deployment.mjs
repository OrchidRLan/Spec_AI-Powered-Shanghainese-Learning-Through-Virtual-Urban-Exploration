/** Offline gate for the explicitly pending-acceptance deployment, never release approval. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, teachingTexts, validateContent, validateConfirmationSupplement } from './validate-content.mjs';
import { validateBatchBCContent } from './validate-bc-content.mjs';
import { checkReviewReuse } from './check-audio-r3.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hashJson = value => sha256(canonicalJson(value));
const AUDIO_SOURCES = ['content/audio-review-r1.json', 'content/audio-review-r2.json', 'content/audio-review-r4.json'];
export const DEPLOYMENT_CONTENT_PATHS = [
  'content/batch-a.json', 'content/reviews.json', 'content/batch-bc.json', 'content/nanxiang-confirmations-r4.json',
  'content/versions/batch-a-r1.2026-10-17.v1.json', 'content/versions/batch-a-r2.2026-10-17.v1.json',
  ...AUDIO_SOURCES, 'content/audio-review-bc.json',
];

function containedPath(root, path) {
  const full = realpathSync(resolve(root, path));
  const rel = relative(realpathSync(root), full);
  if (rel === '..' || rel.startsWith(`..${sep}`) || !statSync(full).isFile()) throw new Error('file must stay inside its asset directory');
  return full;
}

/** Parse the PCM WAV data itself, including truncated chunks and inconsistent metadata. */
export function inspectTeachingWav(bytes) {
  const invalid = () => { throw new Error('invalid or unsupported teaching WAV'); };
  if (bytes.length < 44 || bytes.length > 15 * 1024 * 1024 || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) invalid();
  let format, dataBytes = 0, dataChunks = 0, offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) invalid();
    const size = bytes.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size > bytes.length) invalid();
    const type = bytes.toString('ascii', offset, offset + 4);
    if (type === 'fmt ') {
      if (format || size < 16) invalid();
      format = { codec: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2), sampleRate: bytes.readUInt32LE(start + 4),
        byteRate: bytes.readUInt32LE(start + 8), blockAlign: bytes.readUInt16LE(start + 12), bits: bytes.readUInt16LE(start + 14) };
    }
    if (type === 'data') {
      if (!format) invalid();
      dataBytes += size; dataChunks += 1;
    }
    offset = start + size + size % 2;
  }
  if (offset !== bytes.length || !format || format.codec !== 1 || format.bits !== 16 || ![1, 2].includes(format.channels)
    || format.sampleRate < 8000 || format.sampleRate > 48000 || format.blockAlign !== format.channels * 2
    || format.byteRate !== format.sampleRate * format.blockAlign || dataChunks !== 1 || dataBytes === 0
    || dataBytes % format.blockAlign !== 0) invalid();
  const durationMs = Math.round(dataBytes / format.byteRate * 1000);
  if (durationMs <= 0 || durationMs > 180000) invalid();
  return { format: 'wav', sampleRate: format.sampleRate, channels: format.channels, durationMs };
}

export function validateAudioAssets(clips, { assetRoot = resolve(ROOT, 'frontend/public') } = {}) {
  const errors = [], files = new Map();
  for (const clip of clips) {
    try {
      if (!/^\/audio\/review-(?:r[124]|bc)\/[a-f0-9]{64}\.wav$/u.test(clip.file || '')
        || !clip.file.endsWith(`/${clip.generationId}.wav`)) throw new Error('unsafe or mismatched audio path');
      const path = containedPath(assetRoot, clip.file.slice(1));
      const bytes = readFileSync(path);
      if (sha256(bytes) !== clip.sha256) throw new Error('audio checksum mismatch');
      const measured = inspectTeachingWav(bytes);
      if (Object.keys(measured).some(key => measured[key] !== clip[key])) throw new Error('audio metadata mismatch');
      files.set(clip.file, { file: clip.file, sha256: clip.sha256, bytes: bytes.length });
    } catch (error) { errors.push(`${clip.id || '(unknown clip)'}: ${error.message}`); }
  }
  return { ok: errors.length === 0, errors, files: [...files.values()].sort((a, b) => a.file.localeCompare(b.file)) };
}

function reviewInputHash(entries) {
  return hashJson(entries.map(entry => ({ id: entry.id, version: entry.version, text: entry.hanzi,
    pronunciation: entry.pronunciation ?? null, segments: entry.segments || [] })));
}

function productionStateHash(pack, entries, ledger) {
  return hashJson({ packStatus: pack.status ?? null, release: pack.release ?? null,
    textReviews: Object.fromEntries(entries.map(entry => [entry.id, entry.review ?? null])),
    productionAudioClips: pack.audioClips ?? null, ledger });
}

function validateManifest(pack, manifest, ledger, sourceManifests) {
  const errors = [], entries = pack.entries || teachingTexts(pack), clips = manifest.clips || [];
  const check = (condition, message) => { if (!condition) errors.push(`${manifest.version || 'audio manifest'}: ${message}`); };
  check(manifest.schemaVersion === 1 && manifest.version === pack.contentVersion && manifest.purpose === 'review-draft'
    && manifest.reviewStatus === 'pending', 'manifest identity or pending status changed.');
  check(clips.length === entries.length && new Set(clips.map(clip => clip.id)).size === entries.length
    && new Set(clips.map(clip => clip.textId)).size === entries.length, 'complete, unique audio coverage required.');
  check(manifest.sourceInputSha256 === reviewInputHash(entries), 'source text/notation hash changed.');
  check(manifest.productionApprovalSha256 === productionStateHash(pack, entries, ledger), 'production approval state changed.');
  for (const entry of entries) {
    const clip = clips.find(value => value.textId === entry.id);
    check(clip?.id === entry.audio?.normal && clip?.textVersion === entry.version && clip?.text === entry.hanzi
      && clip?.textSha256 === sha256(entry.hanzi) && clip?.pronunciation === entry.pronunciation
      && clip?.pronunciationVersion === entry.version, `${entry.id}: audio text/version/reading mismatch.`);
    if (!clip) continue;
    check(clip.purpose === 'review-draft' && clip.status === 'generated' && clip.reviewStatus === 'pending'
      && clip.listeningReview === 'pending' && clip.speed === 'normal' && Array.isArray(clip.reviewIds)
      && clip.reviewIds.length === 0, `${entry.id}: audio must preserve pending listening review.`);
    check(clip.generationId === hashJson({ purpose: 'review-draft', text: entry.hanzi, configId: clip.configId,
      targetLanguage: 'wuu', voiceConfig: 'nanxiang-jada-v1', speed: 'normal' }), `${entry.id}: generation identity mismatch.`);
    const config = clip.generationConfig || {};
    check(clip.source === 'tts' && clip.provider === 'aliyun-model-studio' && clip.deployment === 'hosted-api'
      && clip.model === 'qwen3-tts-flash' && clip.voice === 'Jada' && clip.targetLanguage === 'wuu'
      && clip.providerLanguageParameter === 'Chinese' && config.config_id === clip.configId
      && config.model === clip.model && config.voice === clip.voice && config.service === 'tts'
      && config.deployment === clip.deployment && config.region === 'beijing'
      && Number.isFinite(Date.parse(clip.generatedAt)) && typeof clip.upstreamRequestId === 'string'
      && clip.upstreamRequestId.length > 0, `${entry.id}: generation provenance mismatch.`);
    if (manifest.configId) check(clip.configId === manifest.configId, `${entry.id}: manifest configuration mismatch.`);
    if (clip.reusedFrom) {
      const reuse = clip.reusedFrom, source = sourceManifests[reuse.manifest]?.clips.find(value => value.textId === reuse.textId);
      check(Boolean(source) && ['textVersion', 'generationId', 'sha256', 'file'].every(key => reuse[key] === source[key]), `${entry.id}: reuse source mismatch.`);
      if (source) {
        const expected = { ...source, id: clip.id, textId: entry.id, textVersion: entry.version, text: entry.hanzi,
          textSha256: sha256(entry.hanzi), pronunciation: entry.pronunciation, pronunciationVersion: entry.version,
          reused: true, reusedFrom: reuse };
        check(canonicalJson(clip) === canonicalJson(expected) && source.text === entry.hanzi, `${entry.id}: reused recording provenance changed.`);
      }
    }
  }
  return errors;
}

export function validateDeployment({ root = ROOT } = {}) {
  const json = path => JSON.parse(readFileSync(containedPath(root, path), 'utf8'));
  const bytes = path => readFileSync(containedPath(root, path));
  const base = json('content/batch-a.json'), ledger = json('content/reviews.json');
  const r1 = json('content/versions/batch-a-r1.2026-10-17.v1.json');
  const r2 = json('content/versions/batch-a-r2.2026-10-17.v1.json');
  const confirmations = json('content/nanxiang-confirmations-r4.json'), bc = json('content/batch-bc.json');
  const manifests = Object.fromEntries([...AUDIO_SOURCES, 'content/audio-review-bc.json'].map(path => [path, json(path)]));
  const [audioR1, audioR2, audioR4, audioBC] = Object.values(manifests);
  const structural = [validateContent(base, ledger, { root }), validateConfirmationSupplement(confirmations, audioR4, { root }),
    validateBatchBCContent(bc, { root, audioManifest: audioBC, requireAudio: true }), checkReviewReuse(base, r2, audioR2)];
  const errors = structural.flatMap(result => result.errors);
  for (const [pack, manifest] of [[r1, audioR1], [r2, audioR2], [confirmations, audioR4], [bc, audioBC]]) {
    errors.push(...validateManifest(pack, manifest, ledger, manifests));
  }
  if (audioR2.sourceManifestSha256 !== sha256(bytes(AUDIO_SOURCES[0]))) errors.push('R2: source audio manifest hash changed.');
  if (audioR4.sourceContentSha256 !== sha256(bytes(confirmations.sourceContentPath))) errors.push('R4: source snapshot hash changed.');
  if (audioBC.sourceContentSha256 !== hashJson(bc)) errors.push('B+C: source content hash changed.');
  if (audioBC.sourceManifestsSha256 !== hashJson(Object.fromEntries(AUDIO_SOURCES.map(path => [path, sha256(bytes(path))])))) {
    errors.push('B+C: source audio manifest hashes changed.');
  }
  const assets = validateAudioAssets(Object.values(manifests).flatMap(manifest => manifest.clips), { assetRoot: resolve(root, 'frontend/public') });
  errors.push(...assets.errors);
  return { ok: errors.length === 0, mode: 'deployment-pending-acceptance', reviewStatus: 'pending', productionApproved: false,
    errors, networkCalls: 0,
    content: DEPLOYMENT_CONTENT_PATHS.map(path => ({ path, version: json(path).contentVersion || json(path).version || null, sha256: sha256(bytes(path)) })),
    audio: { manifests: Object.entries(manifests).map(([path, manifest]) => ({ path, version: manifest.version, clips: manifest.clips.length,
      reviewStatus: manifest.reviewStatus })), files: assets.files },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('This gate accepts no bypass flags. Use build:release for approved production content.');
    const result = validateDeployment();
    console.log(JSON.stringify({ ...result, audio: { manifests: result.audio.manifests, verifiedFiles: result.audio.files.length } }, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) { console.error(`Deployment validation failed: ${error.message}`); process.exitCode = 1; }
}
