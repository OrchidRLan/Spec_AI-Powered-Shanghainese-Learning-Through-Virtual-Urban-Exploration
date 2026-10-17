import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STAGES = ['language', 'pronunciation', 'approximation', 'audio'];
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const hex = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const bilingual = (value) => value && nonempty(value.zh) && nonempty(value.en);
const array = (value) => Array.isArray(value) ? value : [];
const digest = (value) => createHash('sha256').update(value).digest('hex');

function audioDurationMs(bytes, path) {
  // PCM WAV is the dependency-free publication format used by the first TTS pipeline.
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') {
    if (bytes.readUInt32LE(4) + 8 > bytes.length) throw new Error('truncated WAV container');
    let format = null, dataBytes = 0;
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const size = bytes.readUInt32LE(offset + 4), start = offset + 8;
      if (start + size > bytes.length) throw new Error('truncated WAV chunk');
      const type = bytes.toString('ascii', offset, offset + 4);
      if (type === 'fmt ' && size >= 16) format = {
        codec: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2),
        sampleRate: bytes.readUInt32LE(start + 4), byteRate: bytes.readUInt32LE(start + 8),
        blockAlign: bytes.readUInt16LE(start + 12), bits: bytes.readUInt16LE(start + 14),
      };
      if (type === 'data') dataBytes += size;
      offset = start + size + (size % 2);
    }
    if (format && [1, 3].includes(format.codec)) {
      const validBits = format.codec === 1 ? [8, 16, 24, 32] : [32, 64];
      if (!validBits.includes(format.bits) || format.channels < 1 || format.sampleRate < 1 ||
          format.blockAlign !== format.channels * format.bits / 8 ||
          format.byteRate !== format.sampleRate * format.blockAlign ||
          dataBytes < format.blockAlign || dataBytes % format.blockAlign !== 0) throw new Error('invalid PCM WAV audio data');
      return dataBytes / format.byteRate * 1000;
    }
  }
  // Other actual media formats can be checked when ffprobe is available; JSON or
  // renamed non-audio files must not pass simply because their checksum matches.
  const knownContainer = bytes.toString('ascii', 0, 3) === 'ID3' ||
    (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) ||
    ['OggS', 'fLaC', 'RIFF'].includes(bytes.toString('ascii', 0, 4)) ||
    bytes.toString('ascii', 4, 8) === 'ftyp' ||
    (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3);
  if (!knownContainer) throw new Error('file is not a supported audio container');
  const result = spawnSync('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type,duration:format=duration', '-of', 'json', path], { encoding: 'utf8', timeout: 5000, maxBuffer: 512 * 1024 });
  if (result.error?.code === 'ENOENT') throw new Error('use PCM WAV or provide ffprobe to verify this audio format');
  if (result.error || result.status !== 0) throw new Error('file is not readable audio');
  const probe = JSON.parse(result.stdout);
  const duration = Number(probe.streams?.[0]?.duration ?? probe.format?.duration) * 1000;
  if (probe.streams?.[0]?.codec_type !== 'audio' || !Number.isFinite(duration) || duration <= 0) throw new Error('audio stream or measurable duration missing');
  return duration;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function packageSha256(pack) {
  return digest(canonicalJson(pack));
}

export function teachingTexts(pack) {
  return [...array(pack.expressions), ...array(pack.dialogues), ...array(pack.supportTerms)];
}

/** Review hashes bind a decision to the exact text, pronunciation, or clip reviewed. */
export function reviewSubjectSha256(pack, contentId, stage, clipId) {
  const text = teachingTexts(pack).find((item) => item.id === contentId);
  let subject;
  if (stage === 'editorial') {
    const item = [...array(pack.stations), pack.nanxiangTask].find((entry) => entry?.id === contentId);
    if (!item) throw new Error(`Unknown editorial subject: ${contentId}`);
    const { copyReview: _copyReview, ...copy } = item;
    subject = copy;
  } else if (!text) {
    throw new Error(`Unknown teaching text: ${contentId}`);
  } else if (stage === 'language') {
    subject = { id: text.id, version: text.version, hanzi: text.hanzi, meaning: text.meaning,
      segments: array(text.segments).map(({ id, hanzi, meaning }) => ({ id, hanzi, meaning })),
      acceptableVariants: text.acceptableVariants };
  } else if (stage === 'pronunciation') {
    subject = { languageSha256: reviewSubjectSha256(pack, contentId, 'language'),
      pronunciation: text.pronunciation, pronunciationHelp: text.pronunciationHelp,
      segments: array(text.segments).map(({ id, pronunciation }) => ({ id, pronunciation })),
      referenceReading: text.referenceReading };
  } else if (stage === 'approximation') {
    subject = { pronunciationSha256: reviewSubjectSha256(pack, contentId, 'pronunciation'),
      approximateZh: text.approximateZh,
      segments: array(text.segments).map(({ id, approximateZh }) => ({ id, approximateZh })) };
  } else if (stage === 'audio') {
    const clip = array(pack.audioClips).find((item) => item.id === clipId && item.textId === contentId);
    if (!clip) throw new Error(`Unknown audio subject: ${clipId}`);
    const { status: _status, reviewIds: _reviewIds, ...metadata } = clip;
    subject = { languageSha256: reviewSubjectSha256(pack, contentId, 'language'), clip: metadata };
  } else {
    throw new Error(`Unknown review stage: ${stage}`);
  }
  return digest(canonicalJson(subject));
}

export function validateContent(pack, ledger, { mode = 'development', root = ROOT } = {}) {
  const errors = [], warnings = [];
  const check = (condition, message) => { if (!condition) errors.push(message); };
  if (!['development', 'production'].includes(mode)) errors.push(`Unknown mode: ${mode}`);
  const production = mode === 'production';
  if (!pack || typeof pack !== 'object' || !ledger || typeof ledger !== 'object') {
    return { ok: false, mode, errors: ['Content and review ledger must be objects.'], warnings };
  }
  check(pack.schemaVersion === 1, 'Content schemaVersion must be 1.');
  check(ledger.schemaVersion === 1, 'Review ledger schemaVersion must be 1.');
  check(nonempty(pack.contentVersion), 'Content version is required.');
  check(['draft', 'approved'].includes(pack.status), 'Package status must be draft or approved.');
  for (const key of ['stations', 'expressions', 'dialogues', 'supportTerms', 'audioClips', 'sources', 'ruleExamples']) {
    check(Array.isArray(pack[key]), `${key} must be an array.`);
  }
  for (const key of ['reviewers', 'records', 'releaseApprovals']) check(Array.isArray(ledger[key]), `Ledger ${key} must be an array.`);
  const texts = teachingTexts(pack), clips = array(pack.audioClips), records = array(ledger.records);
  const reviewers = new Map(array(ledger.reviewers).map((item) => [item.id, item]));
  const textsById = new Map(texts.map((item) => [item.id, item]));
  const clipsById = new Map(clips.map((item) => [item.id, item]));
  const recordsById = new Map(records.map((item) => [item.id, item]));
  const sourceIds = new Set(array(pack.sources).map((item) => item.id));
  const unique = (items, name) => {
    const ids = items.map((item) => item?.id);
    check(ids.every(nonempty), `${name} must all have nonempty IDs.`);
    check(new Set(ids).size === ids.length, `${name} IDs must be unique.`);
  };
  unique(texts, 'Teaching text'); unique(clips, 'Audio clip'); unique(records, 'Review record');
  unique(array(pack.stations), 'Station'); unique(array(pack.sources), 'Source');
  unique(array(ledger.reviewers), 'Reviewer'); unique(array(ledger.releaseApprovals), 'Release approval');
  const mediaCache = new Map();
  const file = (path, sha, label, expectedDuration) => {
    if (!nonempty(path)) { errors.push(`${label}: missing file.`); return; }
    const full = resolve(root, path);
    if (isAbsolute(path) || relative(root, full).startsWith('..')) { errors.push(`${label}: file must be inside the repository.`); return; }
    if (!existsSync(full) || !statSync(full).isFile()) { errors.push(`${label}: file does not exist: ${path}`); return; }
    if (relative(realpathSync(root), realpathSync(full)).startsWith('..')) { errors.push(`${label}: symlink escapes the repository.`); return; }
    check(hex(sha), `${label}: SHA256 is missing or malformed.`);
    const bytes = readFileSync(full);
    if (hex(sha)) check(digest(bytes) === sha, `${label}: SHA256 does not match file contents.`);
    try {
      if (!mediaCache.has(full)) mediaCache.set(full, audioDurationMs(bytes, full));
      const measured = mediaCache.get(full);
      if (typeof expectedDuration === 'number') check(Math.abs(measured - expectedDuration) <= Math.max(20, measured * 0.02), `${label}: recorded duration does not match the audio file.`);
    } catch (error) { errors.push(`${label}: ${error.message}.`); }
  };
  const checkSources = (item) => {
    check(array(item.sourceIds).length > 0, `${item.id}: source reference required.`);
    for (const id of array(item.sourceIds)) check(sourceIds.has(id), `${item.id}: unknown source ${id}.`);
  };
  for (const source of array(pack.sources)) {
    check(nonempty(source.version), `${source.id}: source version required.`);
    check(nonempty(source.path) && existsSync(resolve(root, source.path)), `${source.id}: source document missing.`);
  }
  const expectedStations = ['restaurant', 'candy', 'nanxiang', 'teahouse'];
  check(array(pack.stations).length === 4 && expectedStations.every((id) => pack.stations.some((station) => station.id === id)), 'The four station metadata entries are required.');
  for (const station of array(pack.stations)) {
    checkSources(station);
    for (const field of ['name', 'taskTitle', 'taskDescription']) check(bilingual(station[field]), `${station.id}: ${field} needs zh/en.`);
    check(nonempty(station.version), `${station.id}: version required.`);
    check(station.availableWithoutUnlock === true, `${station.id}: stations must remain freely accessible.`);
  }
  for (const id of ['E08', 'E09', 'E05', ...Array.from({ length: 12 }, (_, i) => `NX-N${String(i + 1).padStart(2, '0')}`), 'NX-Q1', 'NX-Q2', 'NX-Q3', 'NX-MODE-HERE', 'NX-ITEM-XLB']) {
    check(textsById.has(id), `Missing required Batch A text: ${id}.`);
  }
  for (const [collection, kind] of [['expressions', 'expression'], ['dialogues', 'dialogue'], ['supportTerms', 'support-term']]) {
    for (const text of array(pack[collection])) check(text.kind === kind, `${text.id}: kind must match its ${collection} collection.`);
  }
  for (const text of texts) {
    checkSources(text);
    check(nonempty(text.version), `${text.id}: version required.`);
    check(bilingual(text.meaning), `${text.id}: meaning needs zh/en.`);
    check(text.hanzi === null || nonempty(text.hanzi), `${text.id}: hanzi must be null or a nonempty string.`);
    check(Array.isArray(text.segments), `${text.id}: segments must be an array.`);
    if (text.hanzi !== null) check(array(text.segments).map((segment) => segment.hanzi).join('') === text.hanzi, `${text.id}: phrase groups must concatenate to hanzi.`);
    unique(array(text.segments), `${text.id} segment`);
    for (const segment of array(text.segments)) {
      check(nonempty(segment.hanzi) && bilingual(segment.meaning), `${text.id}/${segment.id}: grouped characters and zh/en meaning required.`);
      check(segment.pronunciation === null || nonempty(segment.pronunciation), `${segment.id}: pronunciation must be null or nonempty.`);
      check(segment.approximateZh === null || nonempty(segment.approximateZh), `${segment.id}: approximateZh must be null or nonempty.`);
    }
    check(['draft', 'language-reviewed', 'audio-reviewed', 'approved'].includes(text.review?.status), `${text.id}: invalid review status.`);
    for (const stage of STAGES) check(['pending', 'approved'].includes(text.review?.[stage]), `${text.id}: invalid ${stage} review state.`);
    if (['language-reviewed', 'audio-reviewed', 'approved'].includes(text.review?.status)) check(text.review.language === 'approved', `${text.id}: review status requires language approval.`);
    if (['audio-reviewed', 'approved'].includes(text.review?.status)) check(text.review.audio === 'approved', `${text.id}: review status requires audio approval.`);
    for (const id of array(text.review?.recordIds)) check(recordsById.has(id), `${text.id}: missing linked review record ${id}.`);
    const speeds = text.kind === 'dialogue' ? ['normal'] : ['normal', 'slow'];
    for (const speed of speeds) {
      const clip = clipsById.get(text.audio?.[speed]);
      check(Boolean(clip) && clip.textId === text.id && clip.speed === speed, `${text.id}: ${speed} clip reference missing or mismatched.`);
    }
    if (text.review?.status !== 'approved') warnings.push(`${text.id}: language/pronunciation/audio still require approval.`);
  }
  for (const clip of clips) {
    const text = textsById.get(clip.textId);
    check(Boolean(text) && clip.textVersion === text.version, `${clip.id}: text ID/version mismatch.`);
    check(['normal', 'slow'].includes(clip.speed), `${clip.id}: invalid speed.`);
    check(['pending', 'generated', 'approved'].includes(clip.status), `${clip.id}: invalid clip status.`);
    check(text?.audio?.[clip.speed] === clip.id, `${clip.id}: clip is not referenced by its text.`);
    for (const id of array(clip.reviewIds)) check(recordsById.has(id), `${clip.id}: missing linked review record ${id}.`);
    if (clip.file !== null || clip.status !== 'pending') file(clip.file, clip.sha256, clip.id, clip.durationMs);
  }
  const task = pack.nanxiangTask;
  check(task?.id === 'NX-TASK', 'Nanxiang task definition missing.');
  const legacyTask = ['batch-a.2026-10-17.v1', 'batch-a-r1.2026-10-17.v1'].includes(pack.contentVersion);
  if (legacyTask) {
    check(task?.target?.quantity === 2 && task?.target?.normalizedServings === 2 && task?.target?.takeaway === true && task?.item === 'xiaolongbao', 'Historical Nanxiang target must preserve its two-servings-to-go rule.');
  } else {
    check(task?.orderPolicy === 'customer-choice' && task?.item === 'xiaolongbao', 'Nanxiang must allow the customer to choose their order.');
    check(task?.target?.quantity === null && task?.target?.normalizedServings === null && task?.target?.takeaway === null && task?.target?.unit === 'serving', 'Nanxiang must not prescribe a quantity or dining choice.');
    check(task?.quantityRange?.min === 1 && task?.quantityRange?.max === 20, 'Nanxiang valid serving range must remain 1–20.');
    check(Array.isArray(task?.diningOptions) && task.diningOptions.length === 2 && task.diningOptions.includes(false) && task.diningOptions.includes(true), 'Nanxiang must support both for-here and takeaway orders.');
    check(['valid_normalized_servings', 'explicit_dining_choice', 'current_summary_displayed', 'later_confirmation_matches_revision', 'completion_saved'].every(requirement => array(task?.completionRequires).includes(requirement)), 'Nanxiang completion must require a valid chosen order, displayed summary, later confirmation, and saved completion.');
    check(!array(task?.completionRequires).some(requirement => ['normalized_servings_2', 'takeaway_true'].includes(requirement)), 'Nanxiang must not retain fixed two-servings-to-go completion requirements.');
  }
  if (pack.contentVersion === 'batch-a-r3.2026-10-17.v1') {
    check(task?.practiceMode === 'guided-target' && task?.allowAdHocQuestions === false, 'R3 must use guided practice without ad-hoc questions.');
    check(JSON.stringify(task?.questionIds) === JSON.stringify(['NX-N01', 'NX-N02', 'NX-N03', 'NX-N09']) && task?.completionDialogueId === 'NX-N10', 'R3 must retain only the four designed questions and completion line.');
    check(JSON.stringify(task?.historicalOnlyDialogueIds) === JSON.stringify(['NX-N04', 'NX-N05', 'NX-N06', 'NX-N07', 'NX-N08', 'NX-N11', 'NX-N12']), 'R3 branch dialogue must remain explicitly historical.');
    check(array(task?.units).length === 1 && task.units[0].id === 'serving', 'R3 quantities must use servings without unit clarification branches.');
    check(task?.advancePolicy === 'explicit-continue-after-result' && ['evaluated_result_displayed', 'explicit_continue'].every(requirement => array(task?.completionRequires).includes(requirement)), 'R3 requires a displayed result and explicit continuation.');
    check(task?.audioReviewManifest === 'content/audio-review-r2.json', 'R3 reuses the unchanged, pending R2 audio source.');
  }
  check(task?.initialOrder && ['item', 'quantity', 'unit', 'normalizedServings', 'takeaway'].every((field) => task.initialOrder[field] === null), 'Initial order must keep all fields unknown; do not copy the target.');
  check(bilingual(task?.unitExplanation), 'Nanxiang unit explanation needs zh/en.');
  check(array(pack.ruleExamples).length >= 18, 'The first 18 Nanxiang rule examples are required.');
  for (const reviewer of array(ledger.reviewers)) {
    check(nonempty(reviewer.displayName) && typeof reviewer.fluentShanghainese === 'boolean', `${reviewer.id}: actual reviewer identity and fluency declaration required.`);
    check(Array.isArray(reviewer.roles), `${reviewer.id}: reviewer roles required.`);
  }
  for (const record of records) {
    check(reviewers.has(record.reviewerId), `${record.id}: unknown reviewer.`);
    check(['language', 'pronunciation', 'approximation', 'audio', 'editorial'].includes(record.stage), `${record.id}: invalid review stage.`);
    check(['approved', 'changes-requested'].includes(record.decision), `${record.id}: invalid decision.`);
    check(nonempty(record.reviewedAt) && Number.isFinite(Date.parse(record.reviewedAt)), `${record.id}: valid review timestamp required.`);
    check(nonempty(record.notes), `${record.id}: actual review notes required.`);
    check(nonempty(record.contentId) && nonempty(record.contentVersion), `${record.id}: reviewed content ID/version required.`);
    if (record.decision === 'approved') {
      check(hex(record.subjectSha256), `${record.id}: approved review requires subjectSha256.`);
      const currentSubject = [...texts, ...array(pack.stations), task].find((item) => item?.id === record.contentId);
      // Keep older version records as history; only current decisions authorize this package.
      if (currentSubject?.version === record.contentVersion) {
        try { check(record.subjectSha256 === reviewSubjectSha256(pack, record.contentId, record.stage, record.evidence?.clipId), `${record.id}: review subject has changed.`); }
        catch (error) { errors.push(`${record.id}: ${error.message}`); }
      }
    }
  }
  const hasApproval = (item, stage, minimum = 1, clip = null) => {
    const ids = clip ? array(clip.reviewIds) : array(item.copyReview?.recordIds ?? item.review?.recordIds);
    const matching = records.filter((record) => record.contentId === item.id && record.contentVersion === item.version && record.stage === stage && (stage !== 'audio' || record.evidence?.clipId === clip?.id));
    const latest = new Map();
    for (const record of matching.sort((a, b) => Date.parse(a.reviewedAt) - Date.parse(b.reviewedAt))) latest.set(record.reviewerId, record);
    let valid = 0;
    for (const record of latest.values()) {
      const reviewer = reviewers.get(record.reviewerId);
      if (record.decision !== 'approved') { errors.push(`${item.id}/${stage}: unresolved changes requested by ${record.reviewerId}.`); continue; }
      const fluent = !['language', 'pronunciation', 'audio'].includes(stage) || reviewer?.fluentShanghainese === true;
      let hashMatches = false;
      try { hashMatches = record.subjectSha256 === reviewSubjectSha256(pack, item.id, stage, clip?.id); } catch {}
      if (ids.includes(record.id) && reviewer?.roles?.includes(stage) && fluent && hashMatches) valid += 1;
      if (stage === 'pronunciation') check(record.evidence?.referenceAudio === item.referenceReading?.file, `${record.id}: pronunciation review must reference the exact reference reading.`);
      if (stage === 'approximation') check(nonempty(record.evidence?.trialNotes), `${record.id}: approximation review needs actual novice read-aloud notes.`);
      if (stage === 'audio') check(record.evidence?.sha256 === clip?.sha256, `${record.id}: listening review must match the clip checksum.`);
    }
    check(valid >= minimum, `${item.id}/${stage}: requires ${minimum} independent current approval(s), found ${valid}.`);
  };
  // Approved flags are never trusted alone, even in a development run.
  for (const text of texts) {
    for (const stage of ['language', 'pronunciation', 'approximation']) {
      if (production || text.review?.[stage] === 'approved') hasApproval(text, stage, stage === 'language' ? 2 : 1);
    }
    if (production || text.review?.status === 'approved') {
      check(text.review?.status === 'approved' && STAGES.every((stage) => text.review?.[stage] === 'approved'), `${text.id}: all review stages must be approved.`);
      check(text.textKind === 'reviewed-shanghainese', `${text.id}: text is still a semantic draft or candidate.`);
      check(nonempty(text.hanzi) && nonempty(text.pronunciation) && nonempty(text.approximateZh) && bilingual(text.pronunciationHelp), `${text.id}: final characters, Latin pronunciation, Chinese approximation, and zh/en pronunciation help required.`);
      check(array(text.segments).length > 0 && text.segments.every((segment) => nonempty(segment.pronunciation) && nonempty(segment.approximateZh)), `${text.id}: final phrase-aligned pronunciation and approximation required.`);
      file(text.referenceReading?.file, text.referenceReading?.sha256, `${text.id} reference reading`);
      check(reviewers.get(text.referenceReading?.speakerId)?.fluentShanghainese === true, `${text.id}: reference speaker must be a declared fluent reviewer.`);
    }
  }
  for (const clip of clips) {
    if (production || clip.status === 'approved') {
      check(clip.status === 'approved', `${clip.id}: listening approval required.`);
      if (clip.file === null && clip.status === 'pending') file(clip.file, clip.sha256, clip.id);
      check(typeof clip.durationMs === 'number' && clip.durationMs > 0, `${clip.id}: measured positive duration required.`);
      check(['tts', 'human'].includes(clip.source), `${clip.id}: actual audio source required.`);
      if (clip.source === 'tts') check(nonempty(clip.provider) && nonempty(clip.model) && nonempty(clip.voice) && nonempty(clip.voiceConfigVersion) && ['hosted', 'self-hosted'].includes(clip.deployment) && clip.generationConfig && typeof clip.generationConfig === 'object', `${clip.id}: complete TTS provenance required.`);
      if (clip.source === 'human') check(clip.deployment === 'human' && nonempty(clip.voice), `${clip.id}: actual human recording provenance required.`);
      const text = textsById.get(clip.textId);
      if (text) hasApproval(text, 'audio', 1, clip);
    }
  }
  for (const item of [...array(pack.stations), task].filter(Boolean)) {
    if (production || item.copyReview?.status === 'approved') {
      check(item.copyReview?.status === 'approved', `${item.id}: bilingual UI copy needs editorial approval.`);
      hasApproval(item, 'editorial');
    }
  }
  if (production || pack.status === 'approved' || pack.release?.approved === true) {
    check(pack.status === 'approved' && pack.release?.approved === true, 'Package has not been approved for production.');
    const hash = packageSha256(pack);
    const candidates = array(ledger.releaseApprovals).filter((record) => record.contentVersion === pack.contentVersion && record.packageSha256 === hash);
    const latest = new Map();
    for (const record of candidates.sort((a, b) => Date.parse(a.reviewedAt) - Date.parse(b.reviewedAt))) latest.set(record.reviewerId, record);
    check([...latest.values()].some((record) => record.decision === 'approved' && reviewers.get(record.reviewerId)?.roles?.includes('release') && nonempty(record.notes) && Number.isFinite(Date.parse(record.reviewedAt))), 'Missing authorized release decision for the exact package checksum.');
    check(![...latest.values()].some((record) => record.decision === 'changes-requested'), 'Unresolved release changes requested.');
  }
  return { ok: errors.length === 0, mode, errors, warnings,
    summary: { stations: array(pack.stations).length, expressions: array(pack.expressions).length, dialogues: array(pack.dialogues).length, supportTerms: array(pack.supportTerms).length, audioClips: clips.length, approvedAudioClips: clips.filter((clip) => clip.status === 'approved').length } };
}

/** The R4 supplement is explicitly a review-only artifact, never a production approval shortcut. */
export function validateConfirmationSupplement(pack, manifest, { mode = 'development', root = ROOT } = {}) {
  const errors = [];
  const check = (condition, message) => { if (!condition) errors.push(`R4: ${message}`); };
  const version = 'nanxiang-confirmations-r4.2026-10-17.v1';
  const sourcePath = 'content/versions/batch-a-r2.2026-10-17.v1.json';
  const sourceSha = 'ac3f1985e6c8aa784cd08d85b96b9c27a604eb7a55661830d64d55650a9c7240';
  if (!pack || !manifest || !['development', 'production'].includes(mode)) {
    return { ok: false, errors: ['R4: valid supplement, audio manifest and validation mode are required.'] };
  }
  const texts = array(pack.dialogues), clips = array(manifest.clips);
  const expectedIds = [1, 2, 3].flatMap(quantity => ['HERE', 'GO'].map(dining => `NX-CONFIRM-${quantity}-${dining}`));
  check(pack.schemaVersion === 1 && pack.contentVersion === version && pack.purpose === 'review-draft', 'supplement version/purpose mismatch.');
  check(pack.status === 'draft' && pack.reviewStatus === 'pending', 'this version must retain its honest draft status.');
  check(JSON.stringify(pack.appliesToContentVersions) === JSON.stringify(['batch-a-r3.2026-10-17.v1']), 'supplement must bind to the current guided content.');
  check(pack.sourceContentPath === sourcePath && pack.sourceContentVersion === 'batch-a-r2.2026-10-17.v1', 'source snapshot mismatch.');
  check(texts.length === 6 && new Set(texts.map(entry => entry?.id)).size === 6
    && texts.every(entry => expectedIds.includes(entry?.id)), 'exactly the six supported confirmation variants are required.');
  check(manifest.schemaVersion === 1 && manifest.version === version && manifest.purpose === 'review-draft'
    && manifest.reviewStatus === 'pending', 'audio manifest must remain bound to this draft supplement.');
  check(clips.length === 6 && new Set(clips.map(clip => clip?.textId)).size === 6
    && new Set(clips.map(clip => clip?.file)).size === 6
    && clips.every(clip => expectedIds.includes(clip?.textId)), 'six distinct whole-sentence audio files are required.');
  let sources = new Map();
  try {
    const bytes = readFileSync(resolve(root, sourcePath));
    check(digest(bytes) === sourceSha, 'immutable source snapshot has changed.');
    sources = new Map(teachingTexts(JSON.parse(bytes)).map(entry => [entry.id, entry]));
  } catch { errors.push('R4: source snapshot is missing or unreadable.'); }
  for (const text of texts.filter(entry => entry && expectedIds.includes(entry.id))) {
    const quantity = Number(text.id.split('-')[2]), takeaway = text.id.endsWith('-GO');
    const sourceIds = [`NX-Q${quantity}`, 'NX-ITEM-XLB', takeaway ? 'E09' : 'NX-MODE-HERE', 'NX-N09'];
    const expectedSegments = [];
    for (const sourceId of sourceIds) {
      const original = sources.get(sourceId);
      array(original?.segments).forEach((segment, index, segments) => {
        const next = { ...segment, id: `${text.id}-S${String(expectedSegments.length + 1).padStart(2, '0')}` };
        if (['NX-ITEM-XLB', 'E09', 'NX-MODE-HERE'].includes(sourceId) && index === segments.length - 1) next.hanzi += '，';
        expectedSegments.push(next);
      });
    }
    check(text.version === version && text.kind === 'dialogue' && text.textKind === 'shanghainese-candidate', `${text.id}: text identity or draft kind mismatch.`);
    check(text.order?.item === 'xiaolongbao' && text.order?.normalized_servings === quantity && text.order?.takeaway === takeaway, `${text.id}: order mapping mismatch.`);
    check(bilingual(text.meaning), `${text.id}: zh/en meanings required.`);
    check(expectedSegments.length > 0 && text.hanzi === expectedSegments.map(segment => segment.hanzi).join('')
      && canonicalJson(text.segments) === canonicalJson(expectedSegments)
      && text.pronunciation === expectedSegments.map(segment => segment.pronunciation).join(' / '), `${text.id}: wording or aligned readings differ from the draft sources.`);
    check(canonicalJson(text.sourceEntries) === canonicalJson(sourceIds.map(id => ({ id, version: sources.get(id)?.version }))), `${text.id}: source entry versions mismatch.`);
    check(text.review?.status === 'draft' && STAGES.every(stage => text.review?.[stage] === 'pending')
      && array(text.review?.recordIds).length === 0, `${text.id}: a review draft cannot claim human approval.`);
    check(text.audio?.normal === `${text.id}.normal` && text.audio?.slowPlaybackRate === 0.75, `${text.id}: normal/slow audio binding mismatch.`);
    const clip = clips.find(candidate => candidate?.textId === text.id);
    check(clip?.id === text.audio?.normal && clip?.textVersion === version && clip?.text === text.hanzi
      && clip?.pronunciation === text.pronunciation && clip?.pronunciationVersion === version
      && clip?.textSha256 === digest(text.hanzi || ''), `${text.id}: audio sentence/version/reading mismatch.`);
    check(clip?.purpose === 'review-draft' && clip?.status === 'generated' && clip?.reviewStatus === 'pending'
      && clip?.listeningReview === 'pending' && clip?.speed === 'normal' && array(clip?.reviewIds).length === 0,
    `${text.id}: audio must retain its pending listening-review status.`);
    const pathValid = hex(clip?.generationId) && clip?.file === `/audio/review-r4/${clip.generationId}.wav`;
    check(pathValid, `${text.id}: invalid whole-sentence audio path.`);
    if (pathValid) {
      try {
        const path = resolve(root, `frontend/public${clip.file}`);
        check(!relative(realpathSync(root), realpathSync(path)).startsWith('..'), `${text.id}: audio path escapes the repository.`);
        const bytes = readFileSync(path);
        check(hex(clip.sha256) && digest(bytes) === clip.sha256, `${text.id}: audio checksum mismatch.`);
        const duration = audioDurationMs(bytes, path);
        check(typeof clip.durationMs === 'number' && Math.abs(duration - clip.durationMs) <= 1, `${text.id}: audio duration mismatch.`);
      } catch { errors.push(`R4: ${text.id}: whole-sentence audio is missing or unreadable.`); }
    }
    if (mode === 'production') {
      for (const stage of ['language', 'pronunciation', 'audio']) {
        errors.push(`R4: ${text.id}/${stage}: review-only supplement has no production approval.`);
      }
    }
  }
  if (mode === 'production') errors.push('R4: this review-only supplement requires a separately audited production release; changing approved flags is insufficient.');
  return { ok: errors.length === 0, errors, summary: { confirmationDrafts: texts.length, confirmationAudioClips: clips.length, approvedConfirmationAudioClips: 0 } };
}

function main() {
  const args = process.argv.slice(2).flatMap((value) => value === '--production' ? ['--mode', 'production'] : value === '--development' ? ['--mode', 'development'] : [value]);
  const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
  const allowed = new Set(['--mode', '--content', '--reviews', '--hash', '--stage', '--clip']);
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid option: ${args[i]}`);
    if (seen.has(args[i])) throw new Error(`Duplicate option: ${args[i]}`);
    seen.add(args[i]);
  }
  const pack = JSON.parse(readFileSync(resolve(ROOT, option('--content', 'content/batch-a.json')), 'utf8'));
  const ledger = JSON.parse(readFileSync(resolve(ROOT, option('--reviews', 'content/reviews.json')), 'utf8'));
  const hashId = option('--hash', null);
  if (hashId) {
    console.log(hashId === 'package' ? packageSha256(pack) : reviewSubjectSha256(pack, hashId, option('--stage', 'language'), option('--clip', undefined)));
    return;
  }
  const result = validateContent(pack, ledger, { mode: option('--mode', 'development') });
  // These assets are shipped independently of batch-a.json, so a future approval
  // of the base pack must never silently approve the six new confirmation drafts.
  const confirmations = JSON.parse(readFileSync(resolve(ROOT, 'content/nanxiang-confirmations-r4.json'), 'utf8'));
  const confirmationAudio = JSON.parse(readFileSync(resolve(ROOT, 'content/audio-review-r4.json'), 'utf8'));
  const supplement = validateConfirmationSupplement(confirmations, confirmationAudio, { mode: result.mode });
  result.errors.push(...supplement.errors);
  result.ok = result.ok && supplement.ok;
  Object.assign(result.summary, supplement.summary);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`Content validation failed: ${error.message}`); process.exitCode = 1; }
}
