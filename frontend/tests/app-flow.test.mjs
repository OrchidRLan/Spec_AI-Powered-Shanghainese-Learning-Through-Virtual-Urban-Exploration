import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transformWithOxc } from 'vite';

// Run App's real handlers and rendering with deterministic browser/API boundaries.
// Recorder's capture/ASR internals are separately covered by recorder.test.mjs.
const content = JSON.parse(await readFile(new URL('../../content/batch-a.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('../../content/audio-review-r2.json', import.meta.url), 'utf8'));
const confirmationContent = JSON.parse(await readFile(new URL('../../content/nanxiang-confirmations-r4.json', import.meta.url), 'utf8'));
const confirmationManifest = JSON.parse(await readFile(new URL('../../content/audio-review-r4.json', import.meta.url), 'utf8'));
const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const stationContentData = JSON.parse(await readFile(new URL('../../content/batch-bc.json', import.meta.url), 'utf8'));
const jsonDependencies = {};
const componentSource = await readFile(new URL('../src/components/AboutPage.tsx', import.meta.url), 'utf8');
const files = ['components/Toggle.tsx', 'components/AboutPage.tsx', 'lib/i18n.ts', 'lib/conversation.ts', 'lib/reviewAudio.ts', 'lib/orderConfirmation.ts', 'lib/stationContent.ts', 'App.tsx'];
const executable = (await Promise.all(files.map(async file => {
  let source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
  if (file === 'lib/stationContent.ts') source = source.replace(/\bcontent\b/g, 'stationContentData');
  else for (const match of source.matchAll(/^import (\w+) from '([^']+\.json)';/gm)) {
    jsonDependencies[match[1]] = JSON.parse(await readFile(new URL(match[2], new URL(`../src/${file}`, import.meta.url)), 'utf8'));
  }
  source = source.replaceAll('import.meta.env.DEV', 'developmentMode');
  const transformed = await transformWithOxc(source, file, { jsx: { runtime: 'classic' } });
  return transformed.code.replace(/^import\b[\s\S]*?;\n/gm, '')
    .replace(/export default function /g, 'function ').replace(/export (?=(?:function|const) )/g, '');
}))).join('\n');
const icons = [...new Set([appSource, componentSource].flatMap(source => source.match(/import \{([^}]+)\} from 'lucide-react'/)[1].split(',').map(name => name.trim())))];
const entries = [...content.dialogues, ...content.expressions, ...content.supportTerms];
const entry = id => entries.find(value => value.id === id);

function deferred() {
  let resolve; let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const responseValue = (response, ...args) => typeof response === 'function' ? response(...args) : response?.promise ?? response;

function storage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key) };
}

function makeAttempt(change = {}) {
  return {
    id: 'attempt-r2', station_id: 'nanxiang', status: 'collecting', revision: 1,
    order: { item: 'xiaolongbao', quantity: null, unit: null, normalized_servings: null, takeaway: null },
    unresolved_issues: [], summary_revision: null, confirmed_revision: null,
    prompt_id: 'NX-N02', pending_request_id: null, metrics: { voice_attempts: 0, help_used: 0 },
    turns: [], created_at: '', updated_at: '', ...change,
  };
}

function harness(options = {}) {
  const slots = []; const effects = []; const browserEvents = new Map(); const timers = new Map();
  let nextTimer = 0;
  let cursor = 0; let dirty = true; let tree; let disposed = false;
  const requests = []; const reads = []; const preferenceRequests = []; const sessionStorage = options.sessionStorage ?? storage();
  const localStorage = options.localStorage ?? storage({ 'shanghai-review-autovoice': 'off' });
  const attempt = options.attempt ?? makeAttempt();
  const serverSession = {
    id: 'session-r2', locale: options.locale ?? 'en', show_romanization: options.romanization ?? true, reduced_motion: false,
    content_version: options.contentVersion ?? content.contentVersion, rule_version: 'test',
    attempts: options.attempts ?? (options.completed && attempt.status !== 'completed'
      ? [makeAttempt({ id: 'previous-completed', status: 'completed' }), attempt] : [attempt]),
    completed_station_ids: options.completedStationIds ?? (options.completed ? ['nanxiang'] : []), services: {},
  };
  const audio = { src: '', playbackRate: 1, preservesPitch: false, playCalls: 0, pauseCalls: 0,
    async play() { this.playCalls += 1; }, pause() { this.pauseCalls += 1; }, currentTime: 0 };
  const dependenciesMatch = (left, right) => left && right && left.length === right.length
    && left.every((value, index) => Object.is(value, right[index]));
  const useState = initial => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], value => {
      const next = typeof value === 'function' ? value(slots[index]) : value;
      if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true; }
    }];
  };
  const useRef = initial => { const index = cursor++; return slots[index] ??= { current: initial }; };
  const useEffect = (callback, dependencies) => {
    const index = cursor++;
    if (!dependenciesMatch(slots[index]?.dependencies, dependencies)) {
      const previous = slots[index]; const slot = { dependencies, cleanup: previous?.cleanup };
      slots[index] = slot;
      effects.push(() => { slot.cleanup?.(); slot.cleanup = callback(); });
    }
  };
  const components = Object.fromEntries(['Brand', 'Dialog', 'Recorder', 'GuidedPractice', 'StationLesson', 'GardenMap', 'Landmark', 'NanxiangScene', 'LearningText', ...icons]
    .map(name => [name, function boundaryComponent() {}]));
  const window = {
    location: { hash: options.hash ?? '#nanxiang' },
    history: { replaceState: (_state, _title, hash) => { window.location.hash = hash; } },
    addEventListener: (name, callback) => browserEvents.set(name, callback),
    removeEventListener: name => browserEvents.delete(name), scrollTo() {},
  };
  class ApiError extends Error {
    constructor(code, message, attempt, terminal = false, retryable = false) {
      super(message); Object.assign(this, { code, attempt, terminal, retryable });
    }
  }
  const context = {
    developmentMode: options.development ?? true, content, manifest, confirmationContent, confirmationManifest, stationContentData, ...jsonDependencies, ...components, useState, useRef, useEffect,
    React: { createElement: (type, attributes, ...children) => {
      if (typeof type === 'function' && ['Toggle', 'AboutPage'].includes(type.name)) return type({ ...attributes, children });
      if (type === 'audio' && attributes.ref) attributes.ref.current = audio;
      return { type, props: { ...attributes, children } };
    } },
    window, localStorage, sessionStorage,
    document: { documentElement: { lang: '', dataset: {} }, title: '', getElementById: () => null },
    stopAllAudio: () => audio.pause(), requestAnimationFrame: callback => callback(),
    api: async (path, init) => {
      reads.push(path);
      if (path === '/session' && init?.method === 'PATCH') {
        const change = JSON.parse(init.body); preferenceRequests.push(change);
        if (options.preferencesResponse) return responseValue(options.preferencesResponse, change);
        Object.assign(serverSession, change); return { ...serverSession };
      }
      if (path === '/session') return serverSession;
      if (path === '/services') return options.servicesResponse?.promise ?? { asr: { enabled: options.asrEnabled ?? true } };
      if (path === `/attempts/${attempt.id}`) return options.attemptResponse ? responseValue(options.attemptResponse, path) : attempt;
      if (path.startsWith(`/attempts/${attempt.id}/turns/`) && options.recoveryResponse) return responseValue(options.recoveryResponse, path);
      throw new Error(`Unexpected API request: ${path}`);
    },
    post: async (path, body, signal) => {
      requests.push({ path, body, signal });
      if (path === '/events') return {};
      if (path === '/session/new' && options.newSessionResponse) return responseValue(options.newSessionResponse, path, body);
      if (path === '/attempts' && options.beginResponse) return responseValue(options.beginResponse, path, body);
      if (path.endsWith('/cancel') && options.cancelResponse) return responseValue(options.cancelResponse, path, body);
      if (path.endsWith('/turns')) {
        if (options.turnError === 'terminal') throw new ApiError('provider_unavailable', 'Provider unavailable', undefined, true, true);
        if (options.turnError) throw new TypeError('Network response unavailable');
        return options.turnResponse ? responseValue(options.turnResponse, path, body) : new Promise(() => {});
      }
      throw new Error(`Unexpected API request: ${path}`);
    },
    ApiError, AbortController, DOMException, crypto,
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
  };
  const App = vm.runInNewContext(`${executable}\nApp;`, context);
  function flush() {
    for (let loop = 0; dirty && loop < 30; loop += 1) {
      dirty = false; cursor = 0; tree = App();
      while (effects.length) effects.shift()();
    }
    assert.equal(dirty, false, 'App effects settled');
  }
  function elements(node = tree) {
    if (!node || typeof node !== 'object') return [];
    return [node, ...(node.props?.children ?? []).flat(Infinity).filter(child => child != null).flatMap(child => elements(child))];
  }
  function text(node = tree) {
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (!node || typeof node !== 'object') return '';
    return (node.props?.children ?? []).flat(Infinity).filter(child => child != null).map(text).join('');
  }
  const find = predicate => elements().find(predicate);
  flush();
  return {
    requests, reads, preferenceRequests, audio, sessionStorage, localStorage,
    get turnRequests() { return requests.filter(request => request.path.endsWith('/turns')); },
    get text() { return text(); },
    get hash() { return window.location.hash; },
    get title() { return context.document.title; },
    find, textOf: text,
    get recorder() { return find(node => node.type === components.Recorder)?.props; },
    get guided() { return find(node => node.type === components.GuidedPractice)?.props; },
    get lesson() { return find(node => node.type === components.StationLesson)?.props; },
    tab(id) { return find(node => node.props?.id === `tab-${id}`)?.props; },
    click(predicate) {
      const button = typeof predicate === 'string'
        ? find(node => node.type === 'button' && text(node) === predicate) : find(predicate);
      assert.ok(button, 'target button exists'); assert.ok(!button.props.disabled, 'target button enabled');
      button.props.onClick(); flush();
    },
    practice(id) { this.click(node => node.type === 'button' && text(node) === entry(id).meaning.en); },
    hashChange(hash) { window.location.hash = hash; browserEvents.get('hashchange')?.(); flush(); },
    runTimers() { const pending = [...timers.values()]; timers.clear(); for (const callback of pending) callback(); flush(); },
    async settle() {
      for (let index = 0; index < 20; index += 1) { await Promise.resolve(); if (!disposed) flush(); }
    },
    dispose() { disposed = true; for (const slot of slots) slot?.cleanup?.(); },
  };
}

test('each new question starts in Speak; selecting a practice answer does not submit it', async t => {
  const h = harness(); t.after(() => h.dispose()); await h.settle();
  assert.equal(h.tab('speak')['aria-selected'], true);
  assert.equal(h.tab('choose').disabled, true);
  assert.equal(h.recorder, undefined, 'recording appears only after selecting practice content');
  h.practice('NX-Q1');
  assert.ok(h.recorder);
  assert.equal(h.turnRequests.length, 0);
  assert.equal(h.tab('choose').disabled, true);
  assert.ok(h.find(node => node.props?.entry?.id === 'NX-Q1'));
  h.practice('NX-Q3');
  assert.ok(h.find(node => node.props?.entry?.id === 'NX-Q3'));
  assert.equal(h.turnRequests.length, 0);
});

test('the original transcript automatically posts once and never substitutes the practice choice', async t => {
  const h = harness(); t.after(() => h.dispose()); await h.settle(); h.practice('NX-Q2');
  const callback = h.recorder.onTranscript;
  callback('  我要一份。 ', 'asr-original'); callback('  我要一份。 ', 'asr-original');
  await h.settle();
  assert.equal(h.turnRequests.length, 1);
  const body = h.turnRequests[0].body;
  assert.equal(body.text, '  我要一份。 ');
  assert.equal(body.asr_request_id, 'asr-original');
  assert.equal(body.channel, 'voice');
  assert.equal(body.action, undefined);
  assert.equal(body.expected_revision, 1);
});

test('a retry unlocks the same question, survives refresh, and a new question is locked again', async t => {
  const response = deferred(); const h = harness({ turnResponse: response }); t.after(() => h.dispose());
  await h.settle(); h.practice('NX-Q1'); h.recorder.onTranscript('没听清', 'asr-retry'); await h.settle();
  response.resolve({ status: 'applied', attempt: makeAttempt({ revision: 2, prompt_id: 'NX-N12', unresolved_issues: ['quantity_unknown'] }),
    speech_feedback: { outcome: 'retry', reason: 'needs_clarification' } });
  await h.settle();
  assert.equal(h.tab('choose').disabled, false);
  const refreshed = harness({ sessionStorage: h.sessionStorage }); t.after(() => refreshed.dispose());
  await refreshed.settle(); assert.equal(refreshed.tab('choose').disabled, false);
  const next = harness({ sessionStorage: h.sessionStorage, attempt: makeAttempt({ revision: 3, prompt_id: 'NX-N03',
    order: { item: 'xiaolongbao', quantity: 1, normalized_servings: 1, unit: 'serving', takeaway: null } }) });
  t.after(() => next.dispose()); await next.settle();
  assert.equal(next.tab('speak')['aria-selected'], true);
  assert.equal(next.tab('choose').disabled, true);
  assert.equal(next.recorder, undefined);
});

test('a successful spoken answer changes the question and rejects the old recorder callback', async t => {
  const response = deferred(); const h = harness({ turnResponse: response }); t.after(() => h.dispose());
  await h.settle(); h.practice('NX-Q1'); const previousRecorder = h.recorder;
  previousRecorder.onFailure('recognition'); await h.settle();
  previousRecorder.onTranscript('一份', 'asr-quantity'); await h.settle();
  response.resolve({ status: 'applied', attempt: makeAttempt({ revision: 2, prompt_id: 'NX-N03',
    order: { item: 'xiaolongbao', quantity: 1, normalized_servings: 1, unit: 'serving', takeaway: null } }),
    speech_feedback: { outcome: 'accepted', reason: 'understood' } });
  await h.settle();
  assert.equal(h.tab('choose').disabled, true);
  assert.equal(h.recorder, undefined);
  previousRecorder.onTranscript('两份', 'late-asr'); await h.settle();
  assert.equal(h.turnRequests.length, 1);
});

test('recognition and technical failures permit fallback, including a disabled speech service', async t => {
  for (const reason of ['recognition', 'technical']) {
    const h = harness(); t.after(() => h.dispose()); await h.settle(); h.practice('NX-Q1');
    h.recorder.onFailure(reason); await h.settle();
    assert.equal(h.tab('choose').disabled, false);
    assert.equal(h.turnRequests.length, 0, 'failure itself never submits an answer');
    h.click(node => node.props?.id === 'tab-choose');
    assert.equal(h.tab('choose')['aria-selected'], true);
  }
  const unavailable = harness({ asrEnabled: false }); t.after(() => unavailable.dispose()); await unavailable.settle();
  assert.equal(unavailable.tab('choose').disabled, false);
});

test('restored questions wait for service availability before permitting practice or fallback', async t => {
  const services = deferred(); const h = harness({ servicesResponse: services }); t.after(() => h.dispose());
  await h.settle();
  assert.ok(h.tab('speak'), 'the restored session has rendered its current question');
  assert.equal(h.tab('choose').disabled, true);
  for (const id of ['NX-Q1', 'NX-Q2', 'NX-Q3']) {
    const button = h.find(node => node.type === 'button' && h.textOf(node) === entry(id).meaning.en);
    assert.equal(button.props.disabled, true, 'practice selection is blocked until service availability is known');
    button.props.onClick(); await h.settle();
    assert.equal(h.recorder, undefined, 'a premature handler cannot mount a disabled recorder and unlock fallback');
  }
  services.resolve({ asr: { enabled: true } }); await h.settle();
  assert.equal(h.tab('choose').disabled, true, 'temporary unknown service state did not persist a technical failure');
  h.practice('NX-Q1'); assert.ok(h.recorder); assert.equal(h.recorder.enabled, true);
  assert.equal(h.sessionStorage.getItem('shanghai-speech-fallbacks-r2'), null);
});

test('an unknown automatic-submit result blocks new answers until its saved result is recovered', async t => {
  const recovered = makeAttempt({ revision: 2, prompt_id: 'NX-N03',
    order: { item: 'xiaolongbao', quantity: 1, normalized_servings: 1, unit: 'serving', takeaway: null } });
  const h = harness({ turnError: 'network', recoveryResponse: { status: 'applied', attempt: recovered,
    speech_feedback: { outcome: 'accepted', reason: 'understood' } } });
  t.after(() => h.dispose()); await h.settle(); h.practice('NX-Q1');
  h.recorder.onTranscript('一份', 'asr-uncertain'); await h.settle();
  assert.equal(h.turnRequests.length, 1);
  const originalId = h.turnRequests[0].body.request_id;
  assert.ok(h.find(node => node.props?.className === 'pending-recovery'));
  assert.ok(h.find(node => node.type === 'button' && h.textOf(node) === 'Check result'));
  assert.ok(h.find(node => node.type === 'button' && h.textOf(node) === 'Cancel'));
  assert.equal(h.tab('choose').disabled, true);
  assert.equal(h.recorder.disabled, true);
  h.recorder.onTranscript('两份', 'asr-should-not-replace-pending'); await h.settle();
  assert.equal(h.turnRequests.length, 1, 'a second answer cannot replace an unresolved request');
  h.click('Check result'); await h.settle();
  assert.ok(h.reads.includes(`/attempts/attempt-r2/turns/${originalId}`), 'recovery uses the original request identity');
  assert.equal(h.find(node => node.props?.className === 'pending-recovery'), undefined);
  assert.ok(h.find(node => node.props?.entry?.id === 'NX-N03'));
  assert.equal(h.tab('choose').disabled, true);
  h.practice('NX-MODE-HERE'); assert.equal(h.recorder.disabled, false);
});

test('a known terminal provider failure unlocks fallback without an unresolved-result lock', async t => {
  const h = harness({ turnError: 'terminal' }); t.after(() => h.dispose()); await h.settle(); h.practice('NX-Q1');
  h.recorder.onTranscript('一份', 'asr-terminal'); await h.settle();
  assert.equal(h.turnRequests.length, 1);
  assert.equal(h.find(node => node.props?.className === 'pending-recovery'), undefined);
  assert.equal(h.tab('choose').disabled, false);
  h.click(node => node.props?.id === 'tab-choose');
  assert.equal(h.tab('choose')['aria-selected'], true);
});

test('a late recovery result cannot clear or relabel a newer answer after cancellation', async t => {
  const query = deferred(); const cancelled = makeAttempt({ revision: 2 });
  const network = { turnError: 'network', recoveryResponse: query,
    cancelResponse: { status: 'cancelled', attempt: cancelled }, attemptResponse: cancelled };
  const h = harness(network); t.after(() => h.dispose()); await h.settle(); h.practice('NX-Q1');
  h.recorder.onTranscript('一份', 'asr-old'); await h.settle();
  h.click('Check result'); await h.settle();
  h.click('Cancel'); await h.settle();
  assert.equal(h.find(node => node.props?.className === 'pending-recovery'), undefined);
  h.recorder.onTranscript('两份', 'asr-new'); await h.settle();
  assert.equal(h.turnRequests.length, 2);
  const latestId = h.turnRequests[1].body.request_id;
  query.resolve({ status: 'applied', attempt: makeAttempt({ revision: 2, prompt_id: 'NX-N03',
    order: { item: 'xiaolongbao', quantity: 1, normalized_servings: 1, unit: 'serving', takeaway: null } }),
    speech_feedback: { outcome: 'accepted', reason: 'understood' } });
  await h.settle();
  assert.ok(h.find(node => node.props?.className === 'pending-recovery'), 'the newer unresolved answer stays locked');
  assert.ok(h.find(node => node.props?.entry?.id === 'NX-N02'), 'the cancelled query cannot move the question');
  assert.equal(h.find(node => node.props?.className === 'r1-last-reply'), undefined,
    'the old result cannot label the new transcript as applied');
  network.recoveryResponse = () => new Promise(() => {});
  h.click('Check result'); await h.settle();
  assert.equal(h.reads.at(-1), `/attempts/attempt-r2/turns/${latestId}`);
});

test('failed cancellation or failed follow-up refresh retains the original recovery lock', async t => {
  for (const failureStage of ['cancel', 'refresh']) {
    const cancelled = makeAttempt({ revision: 2 });
    const fail = () => { throw new TypeError('Connection lost during cancellation'); };
    const h = harness({
      cancelResponse: failureStage === 'cancel' ? fail : { status: 'cancelled', attempt: cancelled },
      attemptResponse: failureStage === 'refresh' ? fail : cancelled,
      recoveryResponse: () => new Promise(() => {}),
    });
    t.after(() => h.dispose()); await h.settle(); h.practice('NX-Q1');
    h.recorder.onTranscript('一份', `asr-${failureStage}`); await h.settle();
    const originalId = h.turnRequests[0].body.request_id;
    h.click('Cancel'); await h.settle();
    assert.ok(h.find(node => node.props?.className === 'pending-recovery'), `${failureStage} failure remains recoverable`);
    assert.equal(h.recorder.disabled, true);
    h.recorder.onTranscript('两份', 'asr-too-early'); await h.settle();
    assert.equal(h.turnRequests.length, 1, 'a cancellation with unknown outcome cannot permit a new answer');
    h.click('Check result'); await h.settle();
    assert.equal(h.reads.at(-1), `/attempts/attempt-r2/turns/${originalId}`);
  }
});

test('late cancellation POST or refresh after navigation cannot clear a new pending answer', async t => {
  for (const delayedStage of ['cancel', 'refresh']) {
    const delayed = deferred(); const cancelled = makeAttempt({ revision: 2 });
    let cancelCalls = 0; let refreshCalls = 0;
    const h = harness({ turnError: 'network',
      cancelResponse: () => {
        cancelCalls += 1;
        return delayedStage === 'cancel' && cancelCalls === 1 ? delayed.promise : { status: 'cancelled', attempt: cancelled };
      },
      attemptResponse: () => {
        refreshCalls += 1;
        return delayedStage === 'refresh' && refreshCalls === 1 ? delayed.promise : cancelled;
      },
      recoveryResponse: () => new Promise(() => {}),
    });
    t.after(() => h.dispose()); await h.settle(); h.practice('NX-Q1');
    h.recorder.onTranscript('一份', 'asr-before-navigation'); await h.settle();
    h.click('Cancel'); await h.settle();
    h.hashChange('#map'); await h.settle(); h.hashChange('#nanxiang'); await h.settle();
    h.recorder.onTranscript('三份', 'asr-after-navigation'); await h.settle();
    assert.equal(h.turnRequests.length, 2);
    const latestId = h.turnRequests[1].body.request_id;
    delayed.resolve(delayedStage === 'cancel' ? { status: 'cancelled', attempt: cancelled } : cancelled);
    await h.settle();
    assert.ok(h.find(node => node.props?.className === 'pending-recovery'), `late ${delayedStage} cannot release the new lock`);
    assert.equal(h.recorder.disabled, true);
    h.click('Check result'); await h.settle();
    assert.equal(h.reads.at(-1), `/attempts/attempt-r2/turns/${latestId}`);
  }
});

test('speech while editing an order cannot confirm the old summary', async t => {
  const h = harness({ attempt: makeAttempt({ status: 'confirming', prompt_id: 'NX-N09', summary_revision: 4, revision: 4,
    order: { item: 'xiaolongbao', quantity: 2, normalized_servings: 2, unit: 'serving', takeaway: true } }) });
  t.after(() => h.dispose()); await h.settle();
  h.click('Make a change'); h.click('Quantity'); h.practice('NX-Q1');
  h.recorder.onTranscript('对个', 'asr-not-confirmation'); await h.settle();
  assert.equal(h.turnRequests.length, 1);
  assert.equal(h.turnRequests[0].body.text, '对个');
  assert.equal(h.turnRequests[0].body.summary_revision, undefined,
    'an editing answer carries no authority to confirm the previous summary');
});

test('confirmation and repeat replies during an edit retain the local question and replay its audio', async t => {
  for (const reason of ['confirmation_required', 'repeat_requested']) {
    const response = deferred();
    const attempt = makeAttempt({ status: 'confirming', prompt_id: 'NX-N09', summary_revision: 4, revision: 4,
      order: { item: 'xiaolongbao', quantity: 2, normalized_servings: 2, unit: 'serving', takeaway: true } });
    const h = harness({ attempt, turnResponse: response, localStorage: storage({ 'shanghai-review-autovoice': 'on' }) });
    t.after(() => h.dispose()); await h.settle();
    h.click('Make a change'); h.click('Quantity'); h.practice('NX-Q1');
    h.recorder.onTranscript(reason === 'repeat_requested' ? '再说一遍' : '对个', `asr-${reason}`); await h.settle();
    response.resolve({ status: 'applied', attempt: { ...attempt, revision: 5 },
      speech_feedback: { outcome: 'accepted', reason } });
    await h.settle();
    assert.ok(h.find(node => node.props?.entry?.id === 'NX-N02'), 'the visible question is still quantity');
    assert.equal(h.tab('choose').disabled, reason === 'repeat_requested',
      'a non-answer unlocks fallback; an understood repeat request does not count as failure');
    h.runTimers(); await h.settle();
    const quantityClip = manifest.clips.find(clip => clip.textId === 'NX-N02' && clip.textVersion === entry('NX-N02').version);
    assert.ok(quantityClip, 'the current quantity prompt has matching audio');
    assert.equal(h.audio.src, quantityClip.file, 'host audio repeats the local edit question, not the backend confirmation');
  }
});

test('returning to an edit after a successful change requires a fresh speaking attempt', async t => {
  const response = deferred();
  const h = harness({ turnResponse: response, attempt: makeAttempt({ status: 'confirming', prompt_id: 'NX-N09', summary_revision: 4, revision: 4,
    order: { item: 'xiaolongbao', quantity: 2, normalized_servings: 2, unit: 'serving', takeaway: true } }) });
  t.after(() => h.dispose()); await h.settle();
  h.click('Make a change'); h.click('Quantity'); h.practice('NX-Q1');
  h.recorder.onFailure('recognition'); await h.settle();
  assert.equal(h.tab('choose').disabled, false);
  h.recorder.onTranscript('一份', 'asr-edit'); await h.settle();
  response.resolve({ status: 'applied', attempt: makeAttempt({ status: 'confirming', revision: 5,
    summary_revision: 5, prompt_id: 'NX-N09',
    order: { item: 'xiaolongbao', quantity: 1, normalized_servings: 1, unit: 'serving', takeaway: true } }),
    speech_feedback: { outcome: 'accepted', reason: 'understood' } });
  await h.settle();
  assert.equal(h.tab('choose').disabled, true, 'the revised confirmation starts with Speak');
  h.click('Make a change'); h.click('Quantity');
  assert.equal(h.tab('choose').disabled, true, 'a new quantity edit is a new speaking attempt');
  assert.equal(h.recorder, undefined);
});

test('refresh during an order edit restores its question and unlocked fallback', async t => {
  const attempt = makeAttempt({ status: 'confirming', prompt_id: 'NX-N09', summary_revision: 4, revision: 4,
    order: { item: 'xiaolongbao', quantity: 2, normalized_servings: 2, unit: 'serving', takeaway: true } });
  const h = harness({ attempt }); t.after(() => h.dispose()); await h.settle();
  h.click('Make a change'); h.click('Quantity'); h.practice('NX-Q1');
  h.recorder.onFailure('recognition'); await h.settle();
  const refreshed = harness({ attempt, sessionStorage: h.sessionStorage }); t.after(() => refreshed.dispose());
  await refreshed.settle();
  assert.equal(refreshed.tab('choose').disabled, false);
  refreshed.practice('NX-Q1');
  assert.ok(refreshed.recorder);
  assert.ok(refreshed.find(node => node.props?.entry?.id === 'NX-N02'));
});

test('Review overview is accessible with zero completed stops and never opens expressions automatically', async t => {
  for (const attempts of [[], [makeAttempt()], [makeAttempt({ status: 'skipped' })]]) {
    const h = harness({ hash: '#review', attempts }); t.after(() => h.dispose()); await h.settle();
    assert.equal(h.hash, '#review');
    assert.ok(h.find(node => node.props?.className === 'review-page page-shell'));
    const cards = h.find(node => node.props?.className === 'review-stop-grid').props.children.flat(Infinity).filter(Boolean);
    assert.equal(cards.length, 4);
    assert.equal(h.find(node => node.props?.entry), undefined, 'the overview only contains stop status and entry buttons');
    assert.equal(h.find(node => node.props?.className === 'review-stats'), undefined);
    assert.equal(h.find(node => node.props?.className === 'bc-review-tabs'), undefined);
    assert.ok(h.find(node => node.props?.['aria-label'] === 'Start: Shanghai Old Restaurant'));
    assert.match(h.text, /Not started/);
    if (attempts[0]?.status === 'skipped') assert.match(h.text, /Visit later/);
    if (attempts[0]?.status === 'collecting') assert.ok(h.find(node => node.props?.['aria-label'] === 'Continue: Nanxiang Steamed Bun Restaurant'));
  }
});

test('Nanxiang review detail stays unlocked during a repeat attempt and survives refresh', async t => {
  for (const status of ['completed', 'collecting']) {
    const h = harness({ hash: '#review/nanxiang', completed: true, attempt: makeAttempt({ status }) });
    t.after(() => h.dispose()); await h.settle();
    assert.equal(h.hash, '#review/nanxiang');
    for (const id of ['NX-ITEM-XLB', 'NX-Q1', 'NX-Q2', 'NX-Q3', 'NX-MODE-HERE', 'E09', 'E05']) {
      assert.ok(h.find(node => node.props?.entry?.id === id), `${id} is available for review`);
    }
    assert.equal(h.find(node => node.props?.className === 'review-stop-grid'), undefined);
    h.click('Back to all stops');
    assert.equal(h.hash, 'review');
    assert.equal(h.find(node => node.props?.entry), undefined);
    h.click(node => node.props?.['aria-label'] === 'Review: Nanxiang Steamed Bun Restaurant');
    assert.equal(h.hash, 'review/nanxiang');
    assert.ok(h.find(node => node.props?.entry?.id === 'NX-Q1'));
  }
});

test('invalid or unfinished review detail URLs return to overview without clearing the session', async t => {
  for (const hash of ['#review/unknown', '#review/nanxiang', '#review/restaurant']) {
    const h = harness({ hash }); t.after(() => h.dispose()); await h.settle();
    assert.equal(h.hash, 'review');
    assert.ok(h.find(node => node.props?.className === 'review-stop-grid'));
    assert.equal(h.find(node => node.props?.entry), undefined);
    assert.equal(h.requests.length, 0, 'a rejected route cannot change stored progress');
    h.hashChange('#review/another-unknown-stop'); await h.settle();
    assert.equal(h.hash, 'review', 'invalid navigation is canonicalized even from the existing overview');
    h.click(node => node.props?.['aria-label'] === 'Continue: Nanxiang Steamed Bun Restaurant');
    assert.equal(h.hash, 'nanxiang'); assert.ok(h.tab('speak'));
  }
});

test('normal and slow controls change actual playback rate, preserve pitch and persist the preference', async t => {
  const h = harness(); t.after(() => h.dispose()); await h.settle(); h.practice('NX-Q1');
  const speedButton = speed => node => node.type === 'button'
    && node.props?.children?.some(child => child?.type === 'small' && h.textOf(child) === `${speed}×`);
  h.click(speedButton(0.75));
  assert.equal(h.audio.playbackRate, 0.75); assert.equal(h.audio.preservesPitch, true);
  assert.equal(h.localStorage.getItem('shanghai-audio-speed'), '0.75');
  h.click(node => node.props?.['aria-label'] === `Listen to ${entry('NX-Q1').hanzi}`);
  await h.settle(); assert.equal(h.audio.playCalls, 1); assert.equal(h.audio.playbackRate, 0.75);
  assert.equal(h.audio.preservesPitch, true);
  const refreshed = harness({ localStorage: h.localStorage }); t.after(() => refreshed.dispose());
  await refreshed.settle(); refreshed.practice('NX-Q1');
  refreshed.click(node => node.props?.['aria-label'] === `Listen to ${entry('NX-Q1').hanzi}`);
  await refreshed.settle(); assert.equal(refreshed.audio.playbackRate, 0.75);
  h.click(speedButton(1)); assert.equal(h.audio.playbackRate, 1); assert.equal(h.audio.preservesPitch, true);
  assert.equal(h.requests.length, 0, 'playback and preference changes do not call speech APIs');
});

const guidedPractice = (change = {}) => ({ step: 'quantity', step_id: 'r3-quantity', target: { type: 'set_order', quantity: 2, unit: 'serving' }, result: null, can_choose: false, ...change });

test('R3 uses only its four fixed prompts and removes the legacy unit explanation', async t => {
  const prompts = { item: 'NX-N01', quantity: 'NX-N02', mode: 'NX-N03', confirm: 'NX-N09' };
  for (const [step, id] of Object.entries(prompts)) {
    const h = harness({ attempt: makeAttempt({ prompt_id: 'NX-N04', practice: guidedPractice({ step }) }) });
    t.after(() => h.dispose()); await h.settle();
    assert.ok(h.guided);
    assert.ok(h.find(node => node.props?.entry?.id === id));
    assert.equal(h.find(node => node.props?.entry?.id === 'NX-N04'), undefined);
    assert.equal(h.tab('speak'), undefined, 'legacy free-conversation controls are not rendered');
    assert.equal(h.find(node => node.props?.['aria-label'] === 'What is one serving?'), undefined);
    assert.equal(h.text.includes('How much is one serving'), false);
  }
});

test('R3 evaluation updates the result without playing a prompt or unlocking completion', async t => {
  const initial = makeAttempt({ practice: guidedPractice() });
  const h = harness({ attempt: initial, localStorage: storage({ 'shanghai-review-autovoice': 'on' }) });
  t.after(() => h.dispose()); await h.settle();
  h.guided.onAttempt({ ...initial, revision: 2, practice: guidedPractice({ result: { request_id: 'evaluation', transcript: '两份', status: 'correct', reason: 'target_matched' } }) });
  await h.settle(); h.runTimers(); await h.settle();
  assert.equal(h.guided.attempt.practice.step, 'quantity');
  assert.equal(h.guided.attempt.order.quantity, null);
  assert.equal(h.audio.playCalls, 0);
  assert.equal(h.find(node => node.props?.className === 'review-page page-shell'), undefined);
});

test('R3 plays the next fixed prompt only after the explicit continuation callback', async t => {
  const initial = makeAttempt({ practice: guidedPractice() });
  const h = harness({ attempt: initial, localStorage: storage({ 'shanghai-review-autovoice': 'on' }) });
  t.after(() => h.dispose()); await h.settle();
  const next = makeAttempt({ revision: 3, prompt_id: 'NX-N03', practice: guidedPractice({ step: 'mode', step_id: 'r3-mode', target: null }),
    order: { item: 'xiaolongbao', quantity: 2, unit: 'serving', normalized_servings: 2, takeaway: null } });
  h.guided.onAttempt(next); h.guided.onAdvanced(next); await h.settle(); h.runTimers(); await h.settle();
  assert.equal(h.guided.attempt.practice.step, 'mode');
  assert.equal(h.audio.playCalls, 1);
  assert.ok(h.find(node => node.props?.entry?.id === 'NX-N03'));
});

test('R4 renders every complete saved order as the matching full confirmation sentence', async t => {
  for (const locale of ['zh', 'en']) {
    for (const candidate of confirmationContent.dialogues) {
      const order = { item: 'xiaolongbao', quantity: candidate.order.normalized_servings, unit: 'serving', normalized_servings: candidate.order.normalized_servings, takeaway: candidate.order.takeaway };
      const attempt = makeAttempt({ status: 'confirming', prompt_id: 'NX-N09', order, practice: guidedPractice({ step: 'confirm', step_id: 'confirm', target: { type: 'confirm' } }) });
      const h = harness({ attempt, locale }); t.after(() => h.dispose()); await h.settle();
      const visible = h.find(node => node.props?.entry?.id === candidate.id);
      assert.ok(visible, `${locale}: ${candidate.id} is shown after restore`);
      assert.equal(visible.props.entry.hanzi, candidate.hanzi);
      assert.equal(visible.props.locale, locale);
      assert.equal(h.find(node => node.props?.entry?.id === 'NX-N09'), undefined, 'the isolated short question is replaced');
      assert.equal(h.find(node => node.props?.className === 'r1-confirm-summary r2-confirm-summary'), undefined, 'a normal confirmation does not repeat its order below');
      assert.equal(h.guided.attempt.status, 'confirming');
      assert.equal(h.requests.length, 0, 'restoring a confirmation cannot submit or complete it');
    }
  }
});

test('R4 manual and automatic confirmation playback follow the current saved order after edits', async t => {
  const initial = makeAttempt({ prompt_id: 'NX-N03', practice: guidedPractice({ step: 'mode', step_id: 'mode', target: null }) });
  const h = harness({ attempt: initial, localStorage: storage({ 'shanghai-review-autovoice': 'on' }) });
  t.after(() => h.dispose()); await h.settle();
  let revision = 2;
  for (const candidate of confirmationContent.dialogues) {
    const order = { item: 'xiaolongbao', quantity: candidate.order.normalized_servings, unit: 'serving', normalized_servings: candidate.order.normalized_servings, takeaway: candidate.order.takeaway };
    const next = makeAttempt({ revision: revision++, status: 'confirming', prompt_id: 'NX-N09', order, practice: guidedPractice({ step: 'confirm', step_id: `confirm-${revision}`, target: null }) });
    h.guided.onAttempt(next); h.guided.onAdvanced(next); await h.settle(); h.runTimers(); await h.settle();
    const clip = confirmationManifest.clips.find(value => value.textId === candidate.id && value.textVersion === candidate.version);
    assert.ok(clip, 'each displayed confirmation has matching local audio');
    assert.equal(h.audio.src, clip.file, 'explicit advancement plays the complete current order');
    h.click(node => node.props?.['aria-label'] === `Listen to ${candidate.hanzi}`); await h.settle();
    assert.equal(h.audio.src, clip.file, 'manual replay uses that same sentence');
    assert.ok(h.find(node => node.props?.entry?.id === candidate.id));
  }
  assert.equal(h.audio.playCalls, confirmationContent.dialogues.length * 2);
  assert.equal(h.requests.length, 0, 'review recordings do not call speech APIs');
});

test('R4 incomplete and unsupported orders never borrow a confirmation for another quantity', async t => {
  for (const order of [
    { item: null, quantity: 2, unit: 'serving', normalized_servings: 2, takeaway: true },
    { item: 'xiaolongbao', quantity: 2, unit: 'serving', normalized_servings: null, takeaway: true },
    { item: 'xiaolongbao', quantity: 4, unit: 'serving', normalized_servings: 4, takeaway: false },
    { item: 'xiaolongbao', quantity: 2, unit: 'serving', normalized_servings: 2, takeaway: null },
  ]) {
    const h = harness({ attempt: makeAttempt({ status: 'confirming', prompt_id: 'NX-N09', order, practice: guidedPractice({ step: 'confirm' }) }) });
    t.after(() => h.dispose()); await h.settle();
    assert.ok(h.find(node => node.props?.entry?.id === 'NX-N09'));
    const summary = h.find(node => node.props?.className === 'r1-confirm-summary r4-confirm-fallback');
    assert.ok(summary);
    if (order.item === null) assert.match(h.textOf(summary), /^Not yet specified · 2 servings · To go$/);
    assert.equal(h.find(node => confirmationContent.dialogues.some(entry => entry.id === node.props?.entry?.id)), undefined);
    h.click(node => node.props?.['aria-label'] === `Listen to ${entry('NX-N09').hanzi}`); await h.settle();
    assert.equal(h.audio.src, manifest.clips.find(clip => clip.textId === 'NX-N09').file);
  }
});

test('R4 map card hierarchy remains intact as B+C opens all four stops in both languages', async t => {
  for (const locale of ['zh', 'en']) {
    const h = harness({ hash: '#map', locale }); t.after(() => h.dispose()); await h.settle();
    const card = h.find(node => node.type === 'aside' && node.props.className.includes('r4-station-detail'));
    const parts = card.props.children.flat(Infinity).filter(Boolean);
    assert.deepEqual(parts.map(node => node.props.className.split(' ')[0]), ['r4-station-topline', 'r4-station-art', 'r4-station-copy', 'r4-station-action']);
    assert.match(h.textOf(parts[0]), locale === 'zh' ? /第 03 站/ : /STOP 03/);
    const copy = parts[2].props.children.flat(Infinity).filter(Boolean);
    assert.deepEqual(copy.map(node => node.type), ['h2', 'span', 'p'], 'title, duration, then one task description');
    assert.doesNotMatch(h.text, /A conversation awaits|Nanxiang first|Work in progress|About this preview|这一站，聊什么|南翔先行|关于本次预览/);
    assert.equal(h.find(node => node.props?.className === 'phrase-tags'), undefined);
    h.click(node => node.type === 'button' && node.props.className?.includes('marker-candy'));
    assert.doesNotMatch(h.text, /尚未开放|Not open yet|development batch|后续批次/);
    const open = h.find(node => node.props?.className === 'r4-station-action').props.children.flat(Infinity).find(node => node.type === 'button');
    assert.equal(open.props.disabled, false, 'the candy station is now available');
    h.click(node => node === open);
    assert.equal(h.hash, 'candy');
    assert.equal(h.lesson.station, 'candy');
  }
});

test('R4 completion actions keep every icon before its label and remove repeated guidance', async t => {
  for (const locale of ['zh', 'en']) {
    const attempt = makeAttempt({ status: 'completed', prompt_id: 'NX-N10', practice: guidedPractice({ step: 'confirm' }) });
    const h = harness({ attempt, completed: true, locale }); t.after(() => h.dispose()); await h.settle();
    const actions = h.find(node => node.props?.className === 'r1-completed-actions r4-completed-actions');
    const buttons = actions.props.children.flat(Infinity).filter(Boolean);
    assert.equal(buttons.length, 3);
    assert.deepEqual(buttons.map(node => node.props.className), ['primary', 'secondary', 'text-button']);
    for (const button of buttons) {
      const children = button.props.children.flat(Infinity).filter(Boolean);
      assert.equal(typeof children[0].type, 'function', 'the icon comes first');
      assert.equal(children[0].props.size, 18);
      assert.equal(children[1].type, 'span', 'the action label follows the icon');
    }
    assert.doesNotMatch(h.text, /You completed your order|Task completion is not a pronunciation score|你完成了这次点单|任务完成记录不代表/);
    assert.ok(h.find(node => node.props?.entry?.id === 'NX-N10'), 'completed turns keep the completion sentence');
    h.click(node => node === buttons[0]);
    assert.equal(h.hash, 'review/nanxiang');
    assert.doesNotMatch(h.text, /This records conversations and practice|这里记录交流与练习/);
  }
});

function makeLessonAttempt(station, changes = {}) {
  const plan = stationContentData.stationPlans.find(item => item.id === station);
  const step = plan.steps[0];
  return makeAttempt({ id: `saved-${station}`, station_id: station, prompt_id: step.hostEntryId,
    lesson: { step: step.id, step_id: `${station}-step-1`, target: null, answers: {}, result: null, can_choose: false }, ...changes });
}

test('B+C direct station links restore their own saved attempts and shared preferences', async t => {
  for (const station of ['restaurant', 'candy', 'teahouse']) {
    const saved = makeLessonAttempt(station, { revision: 9 });
    const h = harness({ hash: `#${station}`, attempts: [makeAttempt(), saved], localStorage: storage({ 'shanghai-audio-speed': '0.75', 'shanghai-review-autovoice': 'off' }) });
    t.after(() => h.dispose()); await h.settle();
    assert.equal(h.lesson.station, station); assert.equal(h.lesson.attempt.id, saved.id); assert.equal(h.lesson.attempt.revision, 9);
    assert.equal(h.lesson.locale, 'en'); assert.equal(h.lesson.romanization, true); assert.equal(h.lesson.audioSpeed, 0.75);
    assert.equal(h.lesson.servicesReady, true); assert.equal(h.requests.filter(item => item.path === '/attempts').length, 0);
  }
});

test('B+C starting a station sends that station identity and preserves existing Nanxiang progress', async t => {
  for (const station of ['restaurant', 'candy', 'teahouse']) {
    const saved = makeLessonAttempt(station);
    const h = harness({ hash: `#${station}`, beginResponse: saved }); t.after(() => h.dispose()); await h.settle();
    assert.equal(h.lesson.attempt, null); h.lesson.onStart(); await h.settle();
    const request = h.requests.find(item => item.path === '/attempts');
    assert.equal(request.body.station_id, station); assert.equal(request.body.restart, false);
    assert.equal(h.lesson.attempt.id, saved.id); assert.equal(h.hash, station);
    h.hashChange('#nanxiang'); await h.settle();
    assert.equal(h.tab('speak')['aria-selected'], true, 'the original Nanxiang attempt stays usable');
  }
});

test('all three new review details use the completed station even while it is retried', async t => {
  for (const station of ['restaurant', 'candy', 'teahouse']) for (const locale of ['zh', 'en']) {
    const saved = makeLessonAttempt(station, { status: 'completed' });
    const retry = makeLessonAttempt(station, { id: `retry-${station}` });
    const h = harness({ hash: `#review/${station}`, locale, attempts: [makeAttempt(), saved, retry], completedStationIds: [station] });
    t.after(() => h.dispose()); await h.settle();
    assert.ok(h.find(node => node.props?.className === 'review-page page-shell'));
    const heading = h.find(node => node.props?.className === 'page-heading review-detail-heading');
    assert.doesNotMatch(h.textOf(heading), /Nanxiang|南翔/);
    assert.match(h.title, locale === 'zh' ? /复习$/ : /Review$/);
    assert.equal(h.find(node => node.props?.className === 'bc-review-tabs'), undefined);
    for (const id of stationContentData.stationPlans.find(item => item.id === station).reviewEntryIds) {
      assert.ok(h.find(node => node.props?.entry?.id === id), `${id} is available after this station completes`);
    }
    assert.equal(h.find(node => node.props?.entry?.id === 'NX-ITEM-XLB'), undefined);
    h.click(locale === 'zh' ? '返回这一站' : 'Back to this stop'); await h.settle();
    assert.equal(h.lesson.attempt.id, saved.id, 'review returns to the successful attempt, not its unfinished retry');
  }
});

test('completing the teahouse opens its detail and overview reports only that stop as completed', async t => {
  const h = harness({ hash: '#teahouse', attempts: [makeLessonAttempt('teahouse')] }); t.after(() => h.dispose()); await h.settle();
  h.lesson.onAttempt(makeLessonAttempt('teahouse', { revision: 4, status: 'completed' })); await h.settle();
  h.lesson.onReview(); await h.settle();
  assert.equal(h.hash, 'review/teahouse');
  assert.ok(h.find(node => node.props?.entry?.id === stationContentData.stationPlans.find(item => item.id === 'teahouse').reviewEntryIds[0]));
  h.click('Back to all stops');
  const grid = h.find(node => node.props?.className === 'review-stop-grid');
  const cards = grid.props.children.flat(Infinity).filter(Boolean);
  assert.equal(cards.filter(card => h.textOf(card).includes('Completed')).length, 1);
  assert.equal(h.find(node => node.props?.className === 'review-stats'), undefined);
  assert.equal(h.find(node => node.props?.className === 'bc-route-banner'), undefined);
});

test('all completed stops appear only as status cards until their Review button is chosen', async t => {
  const attempts = [makeAttempt({ status: 'completed' }), ...['restaurant', 'candy', 'teahouse'].map(id => makeLessonAttempt(id, { status: 'completed' }))];
  const h = harness({ hash: '#review', attempts, completedStationIds: ['restaurant', 'candy', 'nanxiang', 'teahouse'] });
  t.after(() => h.dispose()); await h.settle();
  const cards = h.find(node => node.props?.className === 'review-stop-grid').props.children.flat(Infinity).filter(Boolean);
  assert.equal(cards.filter(card => h.textOf(card).includes('Completed')).length, 4);
  assert.equal(h.find(node => node.props?.entry), undefined);
  assert.doesNotMatch(h.text, /Four stops\. A little more Shanghai|You have shared a meal|Voice tries|Help used/);
  h.click(node => node.props?.['aria-label'] === 'Review: Shanghai Pear Candy Shop');
  assert.equal(h.hash, 'review/candy');
  assert.ok(h.find(node => node.props?.entry?.id === stationContentData.stationPlans.find(item => item.id === 'candy').reviewEntryIds[0]));
});

test('review details respond to browser back and forward within the same review view', async t => {
  const attempts = ['restaurant', 'teahouse'].map(id => makeLessonAttempt(id, { status: 'completed' }));
  const h = harness({ hash: '#review/restaurant', attempts, completedStationIds: ['restaurant', 'teahouse'] });
  t.after(() => h.dispose()); await h.settle();
  const restaurantId = stationContentData.stationPlans.find(item => item.id === 'restaurant').reviewEntryIds[0];
  const teaId = stationContentData.stationPlans.find(item => item.id === 'teahouse').reviewEntryIds[0];
  assert.ok(h.find(node => node.props?.entry?.id === restaurantId));
  h.hashChange('#review'); await h.settle(); assert.ok(h.find(node => node.props?.className === 'review-stop-grid'));
  h.hashChange('#review/teahouse'); await h.settle(); assert.ok(h.find(node => node.props?.entry?.id === teaId));
  assert.equal(h.find(node => node.props?.entry?.id === restaurantId), undefined);
  h.hashChange('#review/restaurant'); await h.settle(); assert.ok(h.find(node => node.props?.entry?.id === restaurantId));
});

test('each expression plays directly at its own speed, stops other audio and leaves task preferences unchanged', async t => {
  const saved = makeAttempt({ status: 'completed' });
  const h = harness({ hash: '#review/nanxiang', attempt: saved, completed: true, romanization: false, localStorage: storage({ 'shanghai-audio-speed': '0.75', 'shanghai-review-autovoice': 'off' }) });
  t.after(() => h.dispose()); await h.settle();
  assert.equal(h.find(node => node.props?.className === 'r2-speed'), undefined, 'there is no shared speed control');
  assert.equal(h.find(node => node.props?.entry?.id === 'NX-Q1').props.romanization, false);
  let pauses = h.audio.pauseCalls;
  for (const [id, label, rate] of [['NX-Q1', 'Normal', 1], ['NX-Q1', 'Slow', 0.75], ['NX-Q2', 'Normal', 1]]) {
    h.click(node => node.props?.['aria-label'] === `${label}: ${entry(id).hanzi}`); await h.settle();
    assert.equal(h.audio.playbackRate, rate); assert.equal(h.audio.preservesPitch, true);
    assert.ok(h.audio.pauseCalls > pauses, 'new playback stops the previous audio first'); pauses = h.audio.pauseCalls;
    assert.equal(h.localStorage.getItem('shanghai-audio-speed'), '0.75', 'review never persists a task speed');
  }
  assert.equal(h.audio.playCalls, 3);
  h.hashChange('#review'); await h.settle();
  assert.ok(h.audio.pauseCalls > pauses, 'leaving a detail through browser history stops playback');
  assert.equal(h.requests.length, 0, 'local review playback makes no speech service or preference request');
  h.hashChange('#nanxiang'); await h.settle();
  h.click(node => node.props?.['aria-label'] === `Listen to ${entry(saved.prompt_id).hanzi}`); await h.settle();
  assert.equal(h.audio.playbackRate, 0.75, 'the lesson still uses its original speed');
});

test('review Continue enters the latest unfinished station attempt', async t => {
  const latest = makeLessonAttempt('restaurant', { id: 'latest-restaurant', revision: 12 });
  const h = harness({ hash: '#review', attempts: [makeLessonAttempt('restaurant', { id: 'earlier-restaurant' }), latest] });
  t.after(() => h.dispose()); await h.settle();
  h.click(node => node.props?.['aria-label'] === 'Continue: Shanghai Old Restaurant'); await h.settle();
  assert.equal(h.hash, 'restaurant'); assert.equal(h.lesson.attempt.id, 'latest-restaurant');
  assert.equal(h.requests.length, 0, 'continuing never creates or resets the attempt');
});


test('leaving a recording preserves the requested review detail through the leave guard', async t => {
  const h = harness({ completed: true }); t.after(() => h.dispose()); await h.settle();
  h.practice('NX-Q1'); h.recorder.onDraftChange(true); await h.settle();
  h.hashChange('#review/nanxiang'); await h.settle();
  assert.equal(h.hash, '#nanxiang');
  assert.ok(h.find(node => node.type === 'button' && h.textOf(node) === 'Leave and discard recording'));
  assert.equal(h.find(node => node.props?.className === 'review-expression-grid'), undefined);
  h.click('Leave and discard recording'); await h.settle();
  assert.equal(h.hash, 'review/nanxiang');
  assert.ok(h.find(node => node.props?.entry?.id === 'NX-Q1'));
});

test('review playback events belong to its completed station rather than another active attempt', async t => {
  const saved = makeLessonAttempt('candy', { status: 'completed' });
  const h = harness({ hash: '#review/candy', attempts: [makeAttempt(), saved, makeLessonAttempt('candy', { id: 'candy-retry' })], completedStationIds: ['candy'] });
  t.after(() => h.dispose()); await h.settle();
  const phrase = stationContentData.entries.find(item => item.id === stationContentData.stationPlans.find(item => item.id === 'candy').reviewEntryIds[0]);
  h.click(node => node.props?.['aria-label'] === `Normal: ${phrase.hanzi}`); await h.settle();
  h.find(node => node.type === 'audio').props.onPlay(); await h.settle();
  const event = h.requests.find(request => request.path === '/events');
  assert.equal(event.body.attempt_id, saved.id);
  assert.equal(event.body.metadata.text_id, phrase.id);
});


test('Nanxiang closing playback shows the speaking host, then keeps its completed pose and direct review', async t => {
  const initial = makeAttempt({ status: 'confirming', prompt_id: 'NX-N09', practice: guidedPractice({ step: 'confirm', step_id: 'last-confirm' }) });
  const h = harness({ attempt: initial, localStorage: storage({ 'shanghai-review-autovoice': 'on' }) });
  t.after(() => h.dispose()); await h.settle();
  assert.equal(h.audio.playCalls, 0, 'restoration is silent');
  const callbacks = h.guided;
  const completed = makeAttempt({ revision: 5, status: 'completed', prompt_id: 'NX-N10', practice: guidedPractice({ step: 'confirm', step_id: 'last-confirm' }) });
  callbacks.onAttempt(completed); callbacks.onAdvanced(completed); await h.settle(); h.runTimers(); await h.settle();
  assert.equal(h.audio.playCalls, 1);
  assert.equal(h.audio.src, manifest.clips.find(clip => clip.textId === 'NX-N10').file);
  const audio = h.find(node => node.type === 'audio'); audio.props.onPlay(); await h.settle();
  assert.equal(h.find(node => node.props?.pose === 'speaking').props.completed, true, 'the host animation keeps the saved-order presentation');
  audio.props.onEnded(); await h.settle();
  assert.ok(h.find(node => node.props?.pose === 'packed'));
  const actions = h.find(node => node.props?.className === 'r1-completed-actions r4-completed-actions');
  const reviewButton = actions.props.children.flat(Infinity).find(node => node?.type === 'button');
  assert.equal(reviewButton.props.disabled, undefined, 'audio never locks the completed actions');
  h.click(node => node === reviewButton); await h.settle(); assert.equal(h.hash, 'review/nanxiang');
});


test('Nanxiang keeps the saved serving and dining visuals while its completed host is speaking', async () => {
  const source = await readFile(new URL('../src/components/SceneArt.tsx', import.meta.url), 'utf8');
  const transformed = await transformWithOxc(source, 'SceneArt.tsx', { jsx: { runtime: 'classic' } });
  const code = transformed.code.replace(/^import\b[\s\S]*?;?\n/gm, '').replace(/export (?=(?:function|const) )/g, '');
  const runtime = vm.runInNewContext(`${code}\n({ NanxiangScene });`, {
    useId: () => 'nanxiang-scene-test', React: { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) },
  });
  const elements = node => !node || typeof node !== 'object' ? [] : [node, ...(node.props?.children ?? []).flat(Infinity).flatMap(elements)];
  const savedOrder = props => elements(runtime.NanxiangScene(props)).find(node => node.props?.className === 'scene-completed-order');
  for (const quantity of [1, 3, 5]) for (const takeaway of [true, false]) {
    const props = { completed: true, pose: 'speaking', quantity, takeaway };
    const tree = runtime.NanxiangScene(props);
    assert.equal(tree.props['data-pose'], 'speaking');
    const order = savedOrder(props); assert.ok(order);
    assert.equal(order.props['data-servings'], quantity);
    assert.equal(order.props['data-order-mode'], takeaway ? 'takeaway' : 'dine-in');
    assert.equal(elements(order).filter(node => node.props?.['data-serving-index']).length, Math.min(quantity, 3));
    assert.ok(elements(order).some(node => node.props?.className === (takeaway ? 'scene-takeaway-bag' : 'scene-dine-in-order')));
  }
  assert.ok(savedOrder({ pose: 'packed', quantity: 2, takeaway: true }), 'existing previews may still infer completion from their pose');
  assert.equal(savedOrder({ completed: false, pose: 'packing', quantity: 2, takeaway: true }), undefined, 'explicit unsaved status takes precedence');
  assert.equal(savedOrder({ pose: 'speaking', quantity: 2, takeaway: true }), undefined, 'speaking alone cannot imply a saved order');
  assert.equal(savedOrder({ completed: true, pose: 'speaking', quantity: null, takeaway: true }), undefined, 'missing order data never draws an invented quantity');
});


test('turning off host audio during an unresolved Nanxiang save suppresses the captured completion callback', async t => {
  const initial = makeAttempt({ status: 'confirming', prompt_id: 'NX-N09', practice: guidedPractice({ step: 'confirm', step_id: 'last-confirm' }) });
  const h = harness({ attempt: initial, localStorage: storage({ 'shanghai-review-autovoice': 'on' }) });
  t.after(() => h.dispose()); await h.settle();
  const captured = h.guided;
  captured.onBusyChange(true); await h.settle();
  h.click(node => node.props?.['aria-label'] === 'Settings');
  h.click(node => node.props?.['aria-label'] === 'Host audio');
  assert.equal(h.localStorage.getItem('shanghai-review-autovoice'), 'off');
  const completed = makeAttempt({ revision: 5, status: 'completed', prompt_id: 'NX-N10', practice: guidedPractice({ step: 'confirm', step_id: 'last-confirm' }) });
  captured.onAttempt(completed); captured.onAdvanced(completed); captured.onBusyChange(false);
  await h.settle(); h.runTimers(); await h.settle();
  assert.equal(h.audio.playCalls, 0, 'the callback captured while audio was on reads the latest muted preference');
  assert.ok(h.find(node => node.props?.pose === 'packed'));
  h.click(node => node.props?.['aria-label'] === 'Host audio');
  h.runTimers(); await h.settle();
  assert.equal(h.audio.playCalls, 0, 'reenabling host audio does not replay the completed interaction');
  h.click(node => node.props?.['aria-label'] === `Listen to ${entry('NX-N10').hanzi}`); await h.settle();
  assert.equal(h.audio.playCalls, 1, 'manual replay remains available');
});

test('turning off host audio after Nanxiang completion is queued cancels its pending playback', async t => {
  const initial = makeAttempt({ status: 'confirming', prompt_id: 'NX-N09', practice: guidedPractice({ step: 'confirm', step_id: 'last-confirm' }) });
  const h = harness({ attempt: initial, localStorage: storage({ 'shanghai-review-autovoice': 'on' }) });
  t.after(() => h.dispose()); await h.settle();
  const captured = h.guided;
  const completed = makeAttempt({ revision: 5, status: 'completed', prompt_id: 'NX-N10', practice: guidedPractice({ step: 'confirm', step_id: 'last-confirm' }) });
  captured.onAttempt(completed); captured.onAdvanced(completed); await h.settle();
  h.click(node => node.props?.['aria-label'] === 'Settings');
  h.click(node => node.props?.['aria-label'] === 'Host audio');
  h.runTimers(); await h.settle();
  assert.equal(h.audio.playCalls, 0);
  assert.equal(h.localStorage.getItem('shanghai-review-autovoice'), 'off');
});

test('About opens directly in both languages and its CTA preserves the current journey', async t => {
  for (const locale of ['zh', 'en']) for (const hasProgress of [false, true]) {
    const h = harness({ hash: '#about', locale, attempts: hasProgress ? [makeAttempt()] : [] });
    t.after(() => h.dispose()); await h.settle();
    assert.match(h.title, locale === 'zh' ? /介绍$/ : /About$/);
    assert.ok(h.find(node => node.props?.id === 'about-title'));
    const stops = h.find(node => node.props?.className === 'about-stop-grid').props.children.flat(Infinity).filter(Boolean);
    assert.equal(stops.length, 4);
    assert.ok(h.find(node => node.props?.id === 'about-how-title'));
    assert.ok(h.find(node => node.props?.id === 'about-support-title'));
    assert.doesNotMatch(h.text, /Interface state book|界面状态册|Completed|已完成/);
    h.click(locale === 'zh' ? hasProgress ? '继续探索' : '开始探索' : hasProgress ? 'Continue exploring' : 'Start exploring');
    await h.settle();
    assert.equal(h.hash, 'map');
    assert.equal(h.find(node => node.props?.className === 'walking-note'), undefined);
    assert.equal(h.requests.length, 0, 'About never creates an attempt, resets a session or records learning events');
    h.hashChange('#nanxiang'); await h.settle();
    assert.equal(Boolean(h.tab('speak')), hasProgress, 'the existing attempt remains available');
  }
});

test('the three main destinations support direct links and browser back/forward', async t => {
  const h = harness({ hash: '', attempts: [] }); t.after(() => h.dispose()); await h.settle();
  assert.ok(h.find(node => node.props?.className === 'map-page page-shell'), 'the default stays Explore');
  const nav = h.find(node => node.props?.className === 'main-nav');
  assert.equal(nav.props.children.flat(Infinity).filter(Boolean).length, 3);
  h.click('About'); assert.equal(h.hash, 'about');
  h.click('Review'); assert.equal(h.hash, 'review');
  h.hashChange('#about'); assert.ok(h.find(node => node.props?.id === 'about-title'));
  h.hashChange('#review'); assert.ok(h.find(node => node.props?.className === 'review-stop-grid'));
  h.hashChange('#map'); assert.ok(h.find(node => node.props?.className === 'map-page page-shell'));
  assert.equal(h.requests.length, 0);
});

test('About navigation keeps the recording leave guard and requested destination', async t => {
  const h = harness(); t.after(() => h.dispose()); await h.settle();
  h.practice('NX-Q1'); h.recorder.onDraftChange(true); await h.settle();
  h.click('About'); await h.settle();
  assert.equal(h.hash, '#nanxiang');
  assert.equal(h.find(node => node.props?.id === 'about-title'), undefined);
  h.click('Leave and discard recording'); await h.settle();
  assert.equal(h.hash, 'about');
  assert.ok(h.find(node => node.props?.id === 'about-title'));
  assert.equal(h.turnRequests.length, 0);
});

test('the state book remains a development-only direct route with no public footer entry', async t => {
  for (const development of [false, true]) {
    const h = harness({ hash: '#design', development }); t.after(() => h.dispose()); await h.settle();
    assert.equal(Boolean(h.find(node => node.props?.className === 'design-page page-shell')), development);
    assert.equal(Boolean(h.find(node => node.props?.className === 'map-page page-shell')), !development);
    const footer = h.find(node => node.props?.className === 'site-footer');
    assert.doesNotMatch(h.textOf(footer), /Interface state book|界面状态册/);
    h.hashChange('#about'); await h.settle(); h.hashChange('#design'); await h.settle();
    assert.equal(h.hash, development ? 'design' : 'map');
  }
});

test('Settings has no journey reset and its real switches synchronize shared lesson preferences', async t => {
  const result = deferred();
  const h = harness({ preferencesResponse: result }); t.after(() => h.dispose()); await h.settle();
  h.click(node => node.props?.['aria-label'] === 'Settings');
  assert.equal(h.find(node => node.type === 'button' && h.textOf(node) === 'Start a new journey'), undefined);
  const settingSwitch = label => h.find(node => node.props?.role === 'switch' && node.props?.['aria-label'] === label && !h.textOf(node));
  assert.equal(settingSwitch('Show romanization').props['aria-checked'], true);
  h.click(node => node === settingSwitch('Show romanization'));
  assert.equal(settingSwitch('Show romanization').props.disabled, true, 'saving prevents duplicate preference requests');
  assert.equal(settingSwitch('Reduce motion').props.disabled, true);
  assert.deepEqual(h.preferenceRequests, [{ show_romanization: false }]);
  result.resolve({ locale: 'en', show_romanization: false, reduced_motion: false }); await h.settle();
  assert.equal(settingSwitch('Show romanization').props.disabled, false);
  assert.equal(settingSwitch('Show romanization').props['aria-checked'], false);
  assert.equal(h.find(node => node.props?.role === 'switch' && h.textOf(node) === 'Show romanization').props['aria-checked'], false, 'the inline Nanxiang switch agrees');
  h.hashChange('#restaurant'); await h.settle(); assert.equal(h.lesson.romanization, false);
  assert.equal(h.requests.find(request => request.path === '/session/new'), undefined);
});

test('legacy lesson recovery still requires explicit confirmation before creating a new session', async t => {
  const newSession = { id: 'new-version', content_version: content.contentVersion, locale: 'en', attempts: [], completed_station_ids: [], show_romanization: true, reduced_motion: false };
  const h = harness({ contentVersion: 'old-version', newSessionResponse: newSession }); t.after(() => h.dispose()); await h.settle();
  h.click('Start a new journey'); await h.settle();
  assert.equal(h.requests.find(request => request.path === '/session/new'), undefined);
  h.click(node => node.type === 'button' && node.props.className === 'primary' && h.textOf(node) === 'Start a new journey');
  await h.settle(); assert.equal(h.requests.filter(request => request.path === '/session/new').length, 1);
  assert.equal(h.hash, 'map');
  h.click(node => node.props?.['aria-label'] === 'Settings');
  assert.equal(h.find(node => node.type === 'button' && h.textOf(node) === 'Start a new journey'), undefined);
});
