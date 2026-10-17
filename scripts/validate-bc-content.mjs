import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = 'batch-bc.2026-10-17.v1';
const STATIONS = ['restaurant', 'candy', 'teahouse'];
const FLAVORS = ['rose', 'osmanthus', 'mint'];
const array = value => Array.isArray(value) ? value : [];
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const bilingual = value => nonempty(value?.zh) && nonempty(value?.en);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const equalSet = (a, b) => a.length === b.length && new Set(a).size === a.length && a.every(value => b.includes(value));

/** Offline structural checks; production always requires a separately audited release. */
export function validateBatchBCContent(pack, { mode = 'development', root = ROOT, audioManifest = null, requireAudio = false } = {}) {
  const errors = [], warnings = [];
  const check = (condition, message) => { if (!condition) errors.push(`B+C: ${message}`); };
  check(['development', 'production'].includes(mode), `unknown validation mode ${mode}.`);
  if (!pack || typeof pack !== 'object') return { ok: false, mode, errors: ['B+C: content must be an object.'], warnings, summary: {} };
  check(pack.schemaVersion === 1 && pack.contentVersion === VERSION, 'independent content version is required.');
  check(pack.purpose === 'review-draft' && pack.status === 'draft' && pack.reviewStatus === 'pending', 'review supplement cannot claim approval.');
  check(array(pack.compatibleBaseContentVersions).includes('batch-a-r3.2026-10-17.v1'), 'existing Nanxiang content version must remain compatible.');
  const entries = array(pack.entries), plans = array(pack.stationPlans);
  const byId = new Map(entries.map(entry => [entry?.id, entry]));
  const sourceIds = new Set(array(pack.sources).map(source => source?.id));
  check(entries.length > 0 && byId.size === entries.length, 'teaching entry IDs must be present and unique.');
  const referenced = new Set();
  const reference = (id, station, use) => {
    const entry = byId.get(id);
    check(entry && array(entry.stationIds).includes(station), `${station}/${use}: unknown or wrong-station entry ${id}.`);
    if (entry) referenced.add(id);
    return entry;
  };
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') { check(false, 'invalid teaching entry.'); continue; }
    const label = entry.id || '(missing ID)';
    check(nonempty(entry.id) && entry.version === VERSION && entry.textKind === 'shanghainese-candidate', `${label}: candidate identity/version mismatch.`);
    check(['expression', 'dialogue', 'support-term'].includes(entry.kind), `${label}: invalid teaching kind.`);
    check(nonempty(entry.hanzi) && bilingual(entry.meaning), `${label}: Hanzi and zh/en meanings are required.`);
    check(array(entry.stationIds).length > 0 && entry.stationIds.every(id => STATIONS.includes(id)), `${label}: invalid station membership.`);
    check(array(entry.sourceIds).length > 0 && entry.sourceIds.every(id => sourceIds.has(id)), `${label}: source references must resolve.`);
    check(entry.pronunciationSchemeId === pack.pronunciationScheme?.id && nonempty(entry.pronunciation), `${label}: pronunciation scheme is missing.`);
    check(!/\d/u.test(entry.pronunciation || ''), `${label}: this supplement stores unnumbered readings.`);
    const segments = array(entry.segments);
    check(segments.length > 0 && new Set(segments.map(s => s?.id)).size === segments.length, `${label}: segments must be present and unique.`);
    check(segments.map(s => s?.hanzi || '').join('') === entry.hanzi, `${label}: segments must reproduce the complete sentence.`);
    check(segments.map(s => s?.pronunciation || '').join(' / ') === entry.pronunciation, `${label}: sentence and segment readings differ.`);
    for (const segment of segments) {
      const hanzi = Array.from(segment?.hanzi || '').filter(char => /\p{Script=Han}/u.test(char));
      const readings = nonempty(segment?.pronunciation) ? segment.pronunciation.split(/\s+/u) : [];
      check(hanzi.length > 0 && readings.length === hanzi.length && readings.every(s => /^[a-z]+$/u.test(s)), `${label}/${segment?.id}: each character needs one displayable reading.`);
      check(bilingual(segment?.meaning), `${label}/${segment?.id}: bilingual segment meaning missing.`);
      check(segment?.approximateZh === null, `${label}/${segment?.id}: unreviewed approximate spelling must remain absent.`);
    }
    check(entry.approximateZh === null && entry.pronunciationHelp?.zh === null && entry.pronunciationHelp?.en === null, `${label}: unsupported pronunciation aids must remain absent.`);
    check(entry.review?.status === 'draft' && ['language','pronunciation','approximation','audio'].every(stage => entry.review?.[stage] === 'pending') && array(entry.review?.recordIds).length === 0, `${label}: unreviewed content cannot claim human approval.`);
    check(entry.audio?.normal === `${entry.id}.normal` && entry.audio?.slowPlaybackRate === 0.75, `${label}: audio ID or slow playback mode mismatch.`);
    if (mode === 'production') errors.push(`B+C: ${label}: language, pronunciation, and audio review are pending.`);
  }
  check(equalSet(plans.map(p => p?.id), STATIONS), 'exactly the three new stations are required.');
  const expectedSteps = { restaurant: ['preference','recommendation','dish','confirm'], candy: ['flavor','quantity','confirm'], teahouse: ['appreciation','thanks'] };
  for (const plan of plans) {
    if (!plan || !STATIONS.includes(plan.id)) { check(false, 'invalid station plan.'); continue; }
    check([plan.title,plan.taskTitle,plan.taskDescription].every(bilingual), `${plan.id}: bilingual station copy is required.`);
    check(JSON.stringify(array(plan.steps).map(s => s?.id)) === JSON.stringify(expectedSteps[plan.id]), `${plan.id}: use the fixed designed questions only.`);
    reference(plan.completionEntryId, plan.id, 'completion');
    check(array(plan.reviewEntryIds).length > 0, `${plan.id}: completed review requires learning entries.`);
    for (const id of array(plan.reviewEntryIds)) reference(id, plan.id, 'review');
    for (const step of array(plan.steps)) {
      if (!step || typeof step !== 'object') { check(false, `${plan.id}: invalid step.`); continue; }
      check(bilingual(step.title), `${plan.id}/${step.id}: bilingual title required.`);
      if (step.id !== 'confirm') reference(step.hostEntryId, plan.id, `step ${step.id}`);
      else {
        check(step.hostEntryId === null, `${plan.id}: confirmation must resolve the current complete order.`);
        const keys = plan.id === 'restaurant' ? ['fish','chicken'] : FLAVORS;
        check(equalSet(Object.keys(step.summaryEntryIds || {}), keys), `${plan.id}: complete confirmation variants missing or include an invalid order.`);
        for (const [key, id] of Object.entries(step.summaryEntryIds || {})) {
          const entry = reference(id, plan.id, 'confirmation');
          const valid = plan.id === 'restaurant' ? entry?.summary?.dish === key && entry?.summary?.preference === 'not_spicy'
            : entry?.summary?.flavor === key && entry?.summary?.quantity === 2 && entry?.summary?.unit === 'pack';
          check(valid, `${plan.id}/${key}: confirmation sentence has the wrong order mapping.`);
          check(/对伐[？?]$/u.test(entry?.hanzi || '') && (entry?.hanzi || '').length > 3, `${plan.id}/${key}: confirmation requires an order before the question.`);
        }
      }
      const options = array(step.options);
      check(options.length > 0 && new Set(options.map(o => o?.id)).size === options.length, `${plan.id}/${step.id}: unique response options are required.`);
      for (const option of options) reference(option?.entryId, plan.id, `option ${option?.id}`);
    }
    if (plan.id === 'candy') {
      const listening = plan.listening;
      check(plan.steps?.[0]?.requiresIntroduction === true, 'candy flavor choice must require listening or text help.');
      check(listening?.assignment === 'server-random-stable-per-attempt' && listening.revealRequiresUserAction === true && listening.audioOnlyUntilRevealed === true, 'candy assignment/reveal policy mismatch.');
      check(equalSet(array(listening?.flavorOrder), FLAVORS) && equalSet(Object.keys(listening?.introductionEntryIds || {}), FLAVORS), 'candy must offer three equal introduction variants.');
      check(!Object.hasOwn(plan, 'targetFlavor') && !Object.hasOwn(listening || {}, 'targetFlavor'), 'public catalog must not assign a candy target.');
      for (const [flavor,id] of Object.entries(listening?.introductionEntryIds || {})) {
        check(reference(id, plan.id, 'introduction')?.listeningFlavor === flavor, `candy/${flavor}: introduction mapping mismatch.`);
      }
    }
  }
  check(equalSet(array(pack.dishes).map(d => d?.id), ['fish','chicken','tofu']), 'three restaurant dishes are required.');
  check(equalSet(array(pack.flavors).map(f => f?.id), FLAVORS), 'three candy flavors are required.');
  for (const [station,items] of [['restaurant',array(pack.dishes)],['candy',array(pack.flavors)]]) {
    for (const item of items) {
      check(bilingual(item?.title) && bilingual(item?.description), `${station}/${item?.id}: bilingual item copy is required.`);
      reference(item?.entryId, station, 'item'); reference(item?.choiceEntryId, station, 'item expression');
      if (station === 'restaurant') check(item?.spicy === (item?.id === 'tofu'), `${item?.id}: practice-menu spice mapping changed.`);
    }
  }
  check(equalSet(array(pack.audioPolicy?.allTextIds), entries.map(e => e?.id)), 'audio production list must cover every teaching entry exactly once.');
  check(pack.audioPolicy?.normalPlaybackRate === 1 && pack.audioPolicy?.slowPlaybackRate === 0.75 && pack.audioPolicy?.preservePitch === true && pack.audioPolicy?.slowIsPlaybackMode === true, 'normal/slow playback policy mismatch.');
  check(referenced.size === entries.length, 'unreachable teaching entries must not enter the audio budget.');
  check(pack.releaseGate?.approved === false && pack.releaseGate?.requiresIndependentLanguageAndAudioReview === true && array(pack.releaseGate?.recordIds).length === 0, 'draft release gate must remain unapproved.');

  if (requireAudio || audioManifest) {
    check(audioManifest?.version === VERSION, 'audio manifest version mismatch or missing.');
    const clips = array(audioManifest?.clips);
    check(equalSet(clips.map(c => c?.textId), entries.map(e => e?.id)), 'audio clips must cover every sentence exactly once.');
    for (const entry of entries) {
      const clip = clips.find(c => c?.textId === entry.id);
      check(clip?.id === entry.audio?.normal && clip?.textVersion === entry.version && clip?.text === entry.hanzi && clip?.textSha256 === sha256(entry.hanzi) && clip?.pronunciation === entry.pronunciation, `${entry.id}: audio text/version/reading binding mismatch.`);
      check(clip?.status === 'generated' && clip?.reviewStatus === 'pending' && clip?.listeningReview === 'pending' && array(clip?.reviewIds).length === 0, `${entry.id}: generated audio must remain pending review.`);
      const safePath = typeof clip?.file === 'string' && /^\/audio\/review-(?:r[124]|bc)\/[a-f0-9]{64}\.wav$/u.test(clip.file);
      check(safePath, `${entry.id}: unsafe or unsupported audio path.`);
      if (safePath) {
        try {
          const path = resolve(root, `frontend/public${clip.file}`);
          check(!relative(realpathSync(root),realpathSync(path)).startsWith('..'), `${entry.id}: audio escapes repository.`);
          const bytes = readFileSync(path);
          check(sha256(bytes) === clip.sha256, `${entry.id}: audio checksum mismatch.`);
          check(bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WAVE', `${entry.id}: audio must be a WAV file.`);
        } catch { check(false, `${entry.id}: audio file missing or unreadable.`); }
      }
    }
  } else warnings.push('B+C: audio generation is checked separately; this check does not claim audio coverage.');
  if (mode === 'production') errors.push('B+C: this review-only supplement requires a separately audited production release; changing approval flags is insufficient.');
  return { ok: errors.length === 0, mode, errors, warnings, summary: { bcTeachingDrafts: entries.length, bcStations: plans.length, bcApprovedTeachingEntries: 0 } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => !['--production','--audio'].includes(arg))) throw new Error('Use --production and/or --audio only.');
    const pack = JSON.parse(readFileSync(resolve(ROOT,'content/batch-bc.json'),'utf8'));
    const audioPath = resolve(ROOT,'content/audio-review-bc.json');
    const withAudio = args.includes('--audio');
    const result = validateBatchBCContent(pack, { mode: args.includes('--production') ? 'production' : 'development', requireAudio:withAudio,
      audioManifest: withAudio && existsSync(audioPath) ? JSON.parse(readFileSync(audioPath,'utf8')) : null });
    console.log(JSON.stringify(result,null,2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) { console.error(`B+C validation failed: ${error.message}`); process.exitCode = 1; }
}
