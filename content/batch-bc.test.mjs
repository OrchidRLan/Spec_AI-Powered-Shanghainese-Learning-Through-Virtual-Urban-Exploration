import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateBatchBCContent } from '../scripts/validate-bc-content.mjs';

const source = JSON.parse(readFileSync(new URL('./batch-bc.json',import.meta.url),'utf8'));
const copy = () => structuredClone(source);
const expectFailure = (pack, pattern, options) => {
  const result = validateBatchBCContent(pack,options);
  assert.equal(result.ok,false);
  assert.ok(result.errors.some(message => pattern.test(message)),result.errors.join('\n'));
};

test('all three station catalogs resolve every question, choice, confirmation, and review entry', () => {
  const result = validateBatchBCContent(source);
  assert.equal(result.ok,true,result.errors.join('\n'));
  assert.equal(result.summary.bcStations,3);
  assert.equal(result.summary.bcTeachingDrafts,36);
});

test('pending B+C teaching material cannot pass the production release gate', () => {
  expectFailure(source,/separately audited production release/,{mode:'production'});
});

test('flipping package or individual approval flags does not forge language review', () => {
  const pack = copy();
  pack.status = 'approved';
  pack.entries[0].review.language = 'approved';
  pack.releaseGate.approved = true;
  expectFailure(pack,/cannot claim approval|cannot claim human approval|remain unapproved/);
});

test('a missing or extra syllable cannot silently fall back to unaligned romanization', () => {
  const pack = copy();
  pack.entries.find(e => e.id==='BC-TEA-PRAISE').segments[0].pronunciation = 'zo';
  expectFailure(pack,/each character needs one displayable reading/);
});

test('normal playback and slow playback use one text binding with no new tone digits', () => {
  const pack = copy();
  pack.entries.find(e => e.id==='BC-CND-TWO-PACKS').pronunciation = 'ngu6 iau5 / lian6 pau1';
  expectFailure(pack,/unnumbered readings/);
  const rates = copy();
  rates.audioPolicy.slowIsPlaybackMode = false;
  expectFailure(rates,/playback policy mismatch/);
});

test('restaurant confirmation must match the selected dish and cannot confirm spicy tofu', () => {
  const pack = copy();
  const step = pack.stationPlans.find(p=>p.id==='restaurant').steps.at(-1);
  step.summaryEntryIds.fish = 'BC-OLD-CONFIRM-CHICKEN';
  expectFailure(pack,/wrong order mapping/);
  step.summaryEntryIds.tofu = 'BC-OLD-CONFIRM-CHICKEN';
  expectFailure(pack,/invalid order/);
});

test('all candy variants bind the named flavor and two packs to the confirmation sentence', () => {
  const pack = copy();
  const entry = pack.entries.find(e=>e.id==='BC-CND-CONFIRM-MINT');
  entry.summary.flavor = 'rose';
  entry.summary.unit = 'piece';
  expectFailure(pack,/wrong order mapping/);
});

test('candy catalog has no selected target and cannot bypass introduction or text-help action', () => {
  const pack = copy();
  const candy = pack.stationPlans.find(p=>p.id==='candy');
  candy.listening.targetFlavor = 'rose';
  candy.steps[0].requiresIntroduction = false;
  expectFailure(pack,/must not assign a candy target/);
  expectFailure(pack,/require listening or text help/);
});

test('candy introduction does not switch to another flavor under its existing ID', () => {
  const pack = copy();
  pack.stationPlans.find(p=>p.id==='candy').listening.introductionEntryIds.rose = 'BC-CND-INTRO-MINT';
  expectFailure(pack,/introduction mapping mismatch/);
});

test('teahouse stays at appreciation and thanks without an invented order-confirmation turn', () => {
  const pack = copy();
  pack.stationPlans.find(p=>p.id==='teahouse').steps.push({id:'confirm',title:{zh:'确认',en:'Confirm'},hostEntryId:null,options:[{id:'confirm',entryId:'BC-CONFIRM'}]});
  expectFailure(pack,/fixed designed questions only/);
});

test('a cross-station entry or dangling audio ID is rejected before the UI can play wrong content', () => {
  const pack = copy();
  pack.stationPlans.find(p=>p.id==='teahouse').steps[0].hostEntryId = 'BC-OLD-ASK-PREFERENCE';
  pack.entries[0].audio.normal = 'BC-CND-TWO-PACKS.normal';
  expectFailure(pack,/wrong-station entry/);
  expectFailure(pack,/audio ID/);
});

test('strict audio mode rejects a missing manifest rather than treating draft text as playable', () => {
  expectFailure(source,/audio manifest version mismatch or missing/,{requireAudio:true});
});

test('a structurally invalid document reports a validation failure', () => {
  expectFailure(null,/content must be an object/);
  expectFailure({},/independent content version/);
});
