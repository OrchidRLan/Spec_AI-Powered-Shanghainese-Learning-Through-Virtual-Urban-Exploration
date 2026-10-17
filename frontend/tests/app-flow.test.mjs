import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transformWithOxc } from 'vite';

// Run App's real handlers and rendering with deterministic browser/API boundaries.
// Recorder's capture/ASR internals are separately covered by recorder.test.mjs.
const content = JSON.parse(await readFile(new URL('../../content/batch-a.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('../../content/audio-review-r2.json', import.meta.url), 'utf8'));
const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const files = ['lib/i18n.ts', 'lib/conversation.ts', 'lib/reviewAudio.ts', 'App.tsx'];
const executable = (await Promise.all(files.map(async file => {
  const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const transformed = await transformWithOxc(source, file, { jsx: { runtime: 'classic' } });
  return transformed.code.replace(/^import\b[\s\S]*?;\n/gm, '')
    .replace(/export default function /g, 'function ').replace(/export (?=(?:function|const) )/g, '');
}))).join('\n');
const icons = appSource.match(/import \{([^}]+)\} from 'lucide-react'/)[1].split(',').map(name => name.trim());
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
  const requests = []; const reads = []; const sessionStorage = options.sessionStorage ?? storage();
  const localStorage = options.localStorage ?? storage({ 'shanghai-review-autovoice': 'off' });
  const attempt = options.attempt ?? makeAttempt();
  const serverSession = {
    id: 'session-r2', locale: 'en', show_romanization: true, reduced_motion: false,
    content_version: content.contentVersion, rule_version: 'test', attempts: [attempt],
    completed_station_ids: options.completed ? ['nanxiang'] : [], services: {},
  };
  const audio = { src: '', playbackRate: 1, preservesPitch: false, playCalls: 0,
    async play() { this.playCalls += 1; }, pause() {}, currentTime: 0 };
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
  const components = Object.fromEntries(['Dialog', 'Recorder', 'GuidedPractice', 'GardenMap', 'Landmark', 'NanxiangScene', 'LearningText', ...icons]
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
    content, manifest, ...components, useState, useRef, useEffect,
    React: { createElement: (type, attributes, ...children) => {
      if (type === 'audio' && attributes.ref) attributes.ref.current = audio;
      return { type, props: { ...attributes, children } };
    } },
    window, localStorage, sessionStorage,
    document: { documentElement: { lang: '', dataset: {} }, title: '', getElementById: () => null },
    stopAllAudio: () => audio.pause(), requestAnimationFrame: callback => callback(),
    api: async path => {
      reads.push(path);
      if (path === '/session') return serverSession;
      if (path === '/services') return options.servicesResponse?.promise ?? { asr: { enabled: options.asrEnabled ?? true } };
      if (path === `/attempts/${attempt.id}`) return options.attemptResponse ? responseValue(options.attemptResponse, path) : attempt;
      if (path.startsWith(`/attempts/${attempt.id}/turns/`) && options.recoveryResponse) return responseValue(options.recoveryResponse, path);
      throw new Error(`Unexpected API request: ${path}`);
    },
    post: async (path, body, signal) => {
      requests.push({ path, body, signal });
      if (path === '/events') return {};
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
    return [node, ...(node.props?.children ?? []).flat(Infinity).flatMap(child => elements(child))];
  }
  function text(node = tree) {
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (!node || typeof node !== 'object') return '';
    return (node.props?.children ?? []).flat(Infinity).map(text).join('');
  }
  const find = predicate => elements().find(predicate);
  flush();
  return {
    requests, reads, audio, sessionStorage, localStorage,
    get turnRequests() { return requests.filter(request => request.path.endsWith('/turns')); },
    get text() { return text(); },
    get hash() { return window.location.hash; },
    find, textOf: text,
    get recorder() { return find(node => node.type === components.Recorder)?.props; },
    get guided() { return find(node => node.type === components.GuidedPractice)?.props; },
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

test('Review cannot be opened by initial URL or hash navigation before Nanxiang completion', async t => {
  for (const status of ['collecting', 'skipped']) {
    const h = harness({ hash: '#review', attempt: makeAttempt({ status }) }); t.after(() => h.dispose()); await h.settle();
    assert.equal(h.hash, 'map');
    assert.equal(h.find(node => node.props?.className === 'review-page page-shell'), undefined);
    h.hashChange('#review'); await h.settle();
    assert.equal(h.hash, 'map');
    assert.equal(h.find(node => node.props?.className === 'review-page page-shell'), undefined);
  }
});

test('completed Nanxiang unlocks Review and keeps it available during a repeat attempt', async t => {
  for (const status of ['completed', 'collecting']) {
    const h = harness({ hash: '#review', completed: true, attempt: makeAttempt({ status }) });
    t.after(() => h.dispose()); await h.settle();
    assert.ok(h.find(node => node.props?.className === 'review-page page-shell'));
    for (const id of ['NX-ITEM-XLB', 'NX-Q1', 'NX-Q2', 'NX-Q3', 'NX-MODE-HERE', 'E09', 'E05']) {
      assert.ok(h.find(node => node.props?.entry?.id === id), `${id} is available for review`);
    }
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
