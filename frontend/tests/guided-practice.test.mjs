import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transformWithOxc } from 'vite';

// Exercise the real guided-practice render and event handlers. Browser recording
// and API persistence are deterministic boundaries; no microphone/provider runs.
const content = JSON.parse(await readFile(new URL('../../content/batch-a.json', import.meta.url), 'utf8'));
const entries = [...content.dialogues, ...content.expressions, ...content.supportTerms];
const source = await readFile(new URL('../src/components/GuidedPractice.tsx', import.meta.url), 'utf8');
const transformed = await transformWithOxc(source, 'GuidedPractice.tsx', { jsx: { runtime: 'classic' } });
const executable = transformed.code.replace(/^import\b[\s\S]*?;\n/gm, '')
  .replace('export default function GuidedPractice', 'function GuidedPractice');
const icons = [...source.matchAll(/import \{([^}]+)\} from 'lucide-react'/g)]
  .flatMap(match => match[1].split(',').map(name => name.trim()));
const target = quantity => ({ type: 'set_order', quantity, unit: 'serving' });

function deferred() {
  let resolve; let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function storage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key) };
}

function makeAttempt(change = {}, practiceChange = {}) {
  return {
    id: 'attempt-r3', station_id: 'nanxiang', status: 'collecting', revision: 1,
    order: { item: 'xiaolongbao', quantity: null, unit: null, normalized_servings: null, takeaway: null },
    unresolved_issues: [], summary_revision: null, confirmed_revision: null,
    prompt_id: 'NX-N02', pending_request_id: null, metrics: { voice_attempts: 0, help_used: 0 },
    turns: [], created_at: '', updated_at: '', ...change,
    practice: { step: 'quantity', step_id: 'quantity-step-1', target: target(2), result: null, can_choose: false,
      ...change.practice, ...practiceChange },
  };
}

function resultAttempt(status, transcript = '两份', change = {}, practiceChange = {}) {
  return makeAttempt({ revision: 3, ...change }, {
    can_choose: status !== 'correct',
    result: { request_id: 'saved-result-0001', transcript, status,
      reason: status === 'correct' ? 'matches_target' : status === 'incorrect' ? 'target_mismatch' : status,
      channel: 'voice', reported_by: 'server' },
    ...practiceChange,
  });
}

function harness(options = {}) {
  const slots = []; const effects = []; const requests = []; const reads = [];
  const attempts = []; const advances = []; const busy = []; const drafts = []; const phases = []; const events = [];
  const timers = new Map(); let nextTimer = 0;
  const sessionStorage = options.sessionStorage ?? storage();
  let cursor = 0; let dirty = true; let tree; let disposed = false;
  let props;
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
  const useMemo = (callback, dependencies) => {
    const index = cursor++;
    if (!dependenciesMatch(slots[index]?.dependencies, dependencies)) slots[index] = { value: callback(), dependencies };
    return slots[index].value;
  };
  const useCallback = (callback, dependencies) => useMemo(() => callback, dependencies);
  const useEffect = (callback, dependencies) => {
    const index = cursor++;
    if (!dependenciesMatch(slots[index]?.dependencies, dependencies)) {
      const slot = { dependencies, cleanup: slots[index]?.cleanup };
      slots[index] = slot;
      effects.push(() => { slot.cleanup?.(); slot.cleanup = callback(); });
    }
  };
  const components = Object.fromEntries(['LearningText', 'Recorder', ...icons]
    .map(name => [name, function boundaryComponent() {}]));
  class ApiError extends Error {
    constructor(code, message, attempt, terminal = false, retryable = false) {
      super(message); Object.assign(this, { code, attempt, terminal, retryable });
    }
  }
  const value = (response, ...args) => typeof response === 'function' ? response(...args) : response?.promise ?? response;
  const context = {
    ...components, useState, useRef, useMemo, useCallback, useEffect,
    React: { createElement: (type, attributes, ...children) => ({ type, props: { ...attributes, children } }) },
    ApiError, AbortController, DOMException, crypto, sessionStorage,
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
    api: async path => {
      reads.push(path);
      if (options.readResponse) return value(options.readResponse, path);
      throw new Error(`Unexpected read: ${path}`);
    },
    post: async (path, body, signal) => {
      requests.push({ path, body, signal });
      if (path.endsWith('/cancel')) {
        if (options.cancelResponse) return value(options.cancelResponse, path, body);
        throw new Error(`Unexpected cancel: ${path}`);
      }
      if (options.postResponse) return value(options.postResponse, path, body);
      const response = options[`${body.operation}Response`];
      if (response) return value(response, path, body);
      if (body.operation === 'select') {
        const attempt = makeAttempt({ ...props.attempt, revision: props.attempt.revision + 1 }, {
          ...props.attempt.practice, target: body.action, result: null,
        });
        return { request_id: body.request_id, status: 'applied', attempt };
      }
      return new Promise(() => {});
    },
  };
  const GuidedPractice = vm.runInNewContext(`${executable}\nGuidedPractice;`, context);
  const updateAttempt = (next, advanced = false) => {
    attempts.push(next); if (advanced) advances.push(next);
    props = { ...props, attempt: next }; dirty = true;
  };
  props = {
    attempt: options.attempt ?? makeAttempt(), locale: 'en', romanization: true,
    asrEnabled: true, servicesReady: true, disabled: false, stopSignal: 0, entries,
    listenButton: entry => ({ type: 'button', props: { 'data-listen-entry': entry.id, children: ['Listen'] } }),
    onAttempt: next => updateAttempt(next), onAdvanced: next => updateAttempt(next, true),
    onBusyChange: value => busy.push(value), onDraftChange: value => drafts.push(value),
    onPhaseChange: value => phases.push(value), onBeforeMedia() {}, onEvent: (...args) => events.push(args),
    ...options.props,
  };
  function flush() {
    for (let loop = 0; dirty && loop < 40; loop += 1) {
      dirty = false; cursor = 0; tree = GuidedPractice(props);
      while (effects.length) effects.shift()();
    }
    assert.equal(dirty, false, 'guided practice effects settled');
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
  const action = name => find(node => node.props?.['data-practice-action'] === name);
  flush();
  return {
    requests, reads, attempts, advances, busy, drafts, phases, events, sessionStorage, find, action, textOf: text, ApiError,
    get text() { return text(); },
    get attempt() { return props.attempt; },
    get recorder() { return find(node => node.type === components.Recorder)?.props; },
    get result() { return find(node => node.props?.['data-testid'] === 'practice-result'); },
    get transcript() { return find(node => node.props?.['data-testid'] === 'practice-transcript'); },
    operations(operation) { return requests.filter(request => request.body?.operation === operation); },
    click(name) {
      const button = action(name);
      assert.ok(button, `action exists: ${name}`); assert.ok(!button.props.disabled, `action enabled: ${name}`);
      button.props.onClick(); flush();
    },
    update(next) { props = { ...props, ...next }; dirty = true; flush(); },
    async settle() {
      for (let index = 0; index < 30; index += 1) { await Promise.resolve(); if (!disposed) flush(); }
    },
    dispose() { disposed = true; for (const slot of slots) slot?.cleanup?.(); },
  };
}

test('selecting a target persists the choice but does not advance or change the order', async t => {
  const h = harness({ attempt: makeAttempt({}, { target: null }) }); t.after(() => h.dispose());
  assert.equal(h.recorder, undefined);
  h.click('select:NX-Q2'); await h.settle();
  assert.equal(h.operations('select').length, 1);
  assert.equal(h.operations('select')[0].body.action.quantity, 2);
  assert.ok(h.recorder);
  assert.equal(h.attempt.order.quantity, null);
  assert.equal(h.advances.length, 0);
  assert.equal(h.operations('continue').length, 0);
});

test('both correct and incorrect results show the original transcript without advancing', async t => {
  for (const status of ['correct', 'incorrect']) {
    const transcript = status === 'correct' ? '  两分。  ' : 'seven.';
    const attempt = resultAttempt(status, transcript);
    const h = harness({ evaluateResponse: { status: 'applied', attempt } }); t.after(() => h.dispose());
    const original = h.recorder.onTranscript;
    original(transcript, `asr-original-${status}`); original(transcript, `asr-original-${status}`);
    await h.settle();
    assert.equal(h.operations('evaluate').length, 1, 'a repeated ASR callback evaluates once');
    assert.equal(h.operations('evaluate')[0].body.text, transcript);
    assert.equal(h.operations('evaluate')[0].body.asr_request_id, `asr-original-${status}`);
    assert.equal(h.result.props['data-result-status'], status);
    assert.doesNotMatch(h.text, /This checks the expression|Choosing alone does not change|We understood the expression/);
    assert.equal(h.textOf(h.transcript), transcript, 'displayed transcript is never normalized or substituted');
    assert.equal(h.attempt.practice.step, 'quantity');
    assert.equal(h.attempt.order.quantity, null);
    assert.equal(h.advances.length, 0);
    assert.equal(h.operations('continue').length, 0);
  }
});

test('a successful answer only advances after an explicit Next step click', async t => {
  const pending = deferred();
  const h = harness({ attempt: resultAttempt('correct'), continueResponse: pending }); t.after(() => h.dispose());
  assert.equal(h.operations('continue').length, 0);
  const handler = h.action('continue').props.onClick;
  h.click('continue'); handler(); await h.settle();
  assert.equal(h.operations('continue').length, 1, 'double activation cannot advance twice');
  const body = h.operations('continue')[0].body;
  assert.equal(body.result_request_id, 'saved-result-0001');
  assert.notEqual(body.assisted, true);
  assert.equal(h.advances.length, 0, 'the UI waits for saved progress');
  pending.resolve({ status: 'applied', attempt: makeAttempt({ revision: 4, prompt_id: 'NX-N03',
    order: { item: 'xiaolongbao', quantity: 2, unit: 'serving', normalized_servings: 2, takeaway: null } },
  { step: 'mode', step_id: 'mode-step-2', target: null }) });
  await h.settle();
  assert.equal(h.advances.length, 1);
  assert.equal(h.attempt.practice.step, 'mode');
  assert.equal(h.attempt.order.quantity, 2);
});

test('a correct final confirmation remains unfinished until Confirm & complete is saved', async t => {
  const pending = deferred();
  const attempt = resultAttempt('correct', '对个', { status: 'confirming', prompt_id: 'NX-N09', summary_revision: 3,
    order: { item: 'xiaolongbao', quantity: 2, unit: 'serving', normalized_servings: 2, takeaway: true } },
  { step: 'confirm', step_id: 'confirm-step-4', target: { type: 'confirm' } });
  const h = harness({ attempt, continueResponse: pending }); t.after(() => h.dispose());
  assert.equal(h.textOf(h.action('continue')), 'Confirm & complete');
  assert.equal(h.attempt.status, 'confirming'); assert.equal(h.advances.length, 0);
  h.click('continue'); await h.settle();
  assert.equal(h.attempt.status, 'confirming');
  pending.resolve({ status: 'applied', attempt: { ...attempt, status: 'completed', revision: 4, confirmed_revision: 3 } });
  await h.settle(); assert.equal(h.advances.length, 1); assert.equal(h.attempt.status, 'completed');
});

test('failed speech can continue explicitly with the chosen target without being marked correct', async t => {
  const attempt = resultAttempt('incorrect', 'seven.');
  const h = harness({ attempt }); t.after(() => h.dispose());
  assert.equal(h.action('continue'), undefined);
  assert.ok(h.action('retry')); assert.ok(h.action('assisted'));
  h.click('assisted'); await h.settle();
  assert.equal(h.operations('continue').length, 1);
  assert.equal(h.operations('continue')[0].body.assisted, true);
  assert.equal(h.attempt.practice.result.status, 'incorrect');
  assert.equal(h.attempt.order.quantity, null);
});

test('changing the target keeps saved fallback eligibility for the same question', async t => {
  const h = harness({ attempt: resultAttempt('incorrect', 'seven.') }); t.after(() => h.dispose());
  h.click('select:NX-Q3'); await h.settle();
  assert.equal(h.attempt.practice.target.quantity, 3);
  assert.equal(h.attempt.practice.can_choose, true);
  assert.equal(h.attempt.practice.result, null);
  h.click('assisted'); await h.settle();
  assert.equal(h.operations('continue')[0].body.assisted, true);
  assert.equal(h.advances.length, 0);
});

test('a recorder callback from an earlier question cannot evaluate the new question', async t => {
  const h = harness(); t.after(() => h.dispose());
  const previous = h.recorder;
  h.update({ attempt: makeAttempt({ revision: 4, prompt_id: 'NX-N03' }, {
    step: 'mode', step_id: 'mode-step-2', target: { type: 'set_order', takeaway: true },
  }) });
  previous.onTranscript('两份', 'asr-old-question'); previous.onFailure('technical'); await h.settle();
  assert.equal(h.operations('evaluate').length, 0);
});

test('a late callback cannot overwrite the already displayed result for the same target', async t => {
  const h = harness({ evaluateResponse: { status: 'applied', attempt: resultAttempt('correct', '两份') } });
  t.after(() => h.dispose());
  const original = h.recorder.onTranscript;
  original('两份', 'asr-saved-result'); await h.settle();
  assert.equal(h.operations('evaluate').length, 1);
  original('七份', 'asr-late-duplicate'); await h.settle();
  assert.equal(h.operations('evaluate').length, 1, 'the result card cannot be replaced by a discarded recorder');
  assert.equal(h.textOf(h.transcript), '两份');
});

test('a retry returns to speaking while retaining the saved fallback and waiting for a new result', async t => {
  const h = harness({ attempt: resultAttempt('incorrect', 'seven.') }); t.after(() => h.dispose());
  h.click('retry'); await h.settle();
  assert.equal(h.result, undefined);
  assert.ok(h.recorder); assert.ok(h.action('assisted'));
  assert.equal(h.attempt.practice.can_choose, true);
  assert.equal(h.operations('continue').length, 0);
  h.recorder.onTranscript('两份', 'asr-retry-correct'); await h.settle();
  assert.equal(h.operations('evaluate').length, 1);
  assert.equal(h.operations('evaluate')[0].body.text, '两份');
});

test('retrying the same target rejects callbacks from its previous recorder', async t => {
  const h = harness({ evaluateResponse: { status: 'applied', attempt: resultAttempt('incorrect', 'seven.') } });
  t.after(() => h.dispose());
  const previous = h.recorder;
  previous.onTranscript('seven.', 'asr-before-retry'); await h.settle();
  h.click('retry'); await h.settle();
  previous.onTranscript('两份', 'asr-old-after-retry'); previous.onFailure('technical'); await h.settle();
  assert.equal(h.operations('evaluate').length, 1);
  assert.ok(h.recorder, 'the new recording opportunity remains open');
  h.recorder.onTranscript('两份', 'asr-current-retry'); await h.settle();
  assert.equal(h.operations('evaluate').length, 2);
  assert.equal(h.operations('evaluate')[1].body.asr_request_id, 'asr-current-retry');
});

test('unknown service availability cannot open a recorder or persist a false technical failure', async t => {
  const h = harness({ props: { servicesReady: false } }); t.after(() => h.dispose());
  assert.equal(h.recorder, undefined);
  assert.equal(h.action('select:NX-Q1').props.disabled, true);
  h.action('select:NX-Q1').props.onClick(); await h.settle();
  assert.equal(h.requests.length, 0);
  h.update({ servicesReady: true, asrEnabled: true }); await h.settle();
  assert.ok(h.recorder); assert.equal(h.recorder.enabled, true);
  assert.equal(h.attempt.practice.can_choose, false);
});

test('a known unavailable service records a persistent technical outcome and enables assistance', async t => {
  const h = harness({ props: { asrEnabled: false },
    evaluateResponse: { status: 'applied', attempt: resultAttempt('technical', null) } });
  t.after(() => h.dispose());
  assert.equal(h.recorder.enabled, false);
  // Recorder's unavailable-service effect is covered by recorder.test.mjs.
  h.recorder.onFailure('technical'); await h.settle();
  assert.equal(h.operations('evaluate')[0].body.failure_kind, 'technical');
  assert.equal(h.result.props['data-result-status'], 'technical');
  assert.ok(h.action('assisted'));
  const refreshed = harness({ attempt: h.attempt, props: { asrEnabled: false } }); t.after(() => refreshed.dispose());
  await refreshed.settle();
  assert.equal(refreshed.result.props['data-result-status'], 'technical');
  assert.ok(refreshed.action('assisted')); assert.equal(refreshed.requests.length, 0);
});

test('saved target, transcript and result are visible on refresh without another evaluation', t => {
  for (const status of ['correct', 'incorrect', 'unrecognized', 'technical']) {
    const transcript = ['correct', 'incorrect'].includes(status) ? '  原始文字。 ' : null;
    const h = harness({ attempt: resultAttempt(status, transcript) }); t.after(() => h.dispose());
    assert.equal(h.result.props['data-result-status'], status);
    assert.doesNotMatch(h.text, /This checks the expression|Choosing alone does not change|We understood the expression/);
    if (transcript !== null) assert.equal(h.textOf(h.transcript), transcript);
    assert.ok(h.find(node => node.props?.entry?.id === 'NX-Q2'), 'selected target is restored');
    assert.equal(h.requests.length, 0);
    assert.equal(h.advances.length, 0);
    if (status !== 'correct') assert.ok(h.action('assisted'));
  }
});

test('recording failures persist an honest unrecognized or technical result without fabricated text', async t => {
  for (const [failure, status] of [['recognition', 'unrecognized'], ['technical', 'technical']]) {
    const h = harness({ evaluateResponse: { status: 'applied', attempt: resultAttempt(status, null) } });
    t.after(() => h.dispose()); h.recorder.onFailure(failure); await h.settle();
    assert.equal(h.operations('evaluate').length, 1);
    const body = h.operations('evaluate')[0].body;
    assert.equal(body.failure_kind, failure); assert.equal(body.text, undefined);
    assert.equal(h.result.props['data-result-status'], status);
    assert.doesNotMatch(h.text, /This checks the expression|Choosing alone does not change|We understood the expression/);
    assert.ok(h.action('assisted')); assert.equal(h.advances.length, 0);
  }
});

test('a provider failure preserves its request identity for server-side verification', async t => {
  const h = harness({ evaluateResponse: { status: 'applied', attempt: resultAttempt('technical', null) } });
  t.after(() => h.dispose());
  h.recorder.onFailure('technical', { requestId: 'saved-asr-failure', message: 'Provider unavailable' });
  await h.settle();
  assert.equal(h.operations('evaluate')[0].body.asr_request_id, 'saved-asr-failure');
  assert.equal(h.operations('evaluate')[0].body.text, undefined);
  assert.equal(h.result.props['data-result-status'], 'technical');
  assert.doesNotMatch(h.text, /Incorrect ·|Provider unavailable/);
});

test('an unknown evaluation shows its transcript and locks new answers until recovery', async t => {
  const h = harness({ evaluateResponse: () => { throw new TypeError('Connection lost'); },
    readResponse: { status: 'applied', attempt: resultAttempt('incorrect', 'seven.') } });
  t.after(() => h.dispose());
  const recorder = h.recorder;
  recorder.onTranscript('seven.', 'asr-uncertain'); await h.settle();
  assert.match(h.text, /seven\./);
  assert.ok(h.action('recover')); assert.ok(h.action('cancel'));
  assert.equal(h.action('select:NX-Q1').props.disabled, true);
  recorder.onTranscript('两份', 'asr-would-replace'); await h.settle();
  assert.equal(h.operations('evaluate').length, 1);
  const requestId = h.operations('evaluate')[0].body.request_id;
  h.click('recover'); await h.settle();
  assert.ok(h.reads.includes(`/attempts/attempt-r3/practice/${requestId}`));
  assert.equal(h.result.props['data-result-status'], 'incorrect');
  assert.equal(h.textOf(h.transcript), 'seven.');
  assert.equal(h.action('recover'), undefined); assert.equal(h.advances.length, 0);
});

test('an unresolved cancellation keeps the same recovery identity and answer lock', async t => {
  const h = harness({ evaluateResponse: () => { throw new TypeError('Connection lost'); },
    cancelResponse: () => { throw new TypeError('Cancellation response lost'); },
    readResponse: () => new Promise(() => {}) });
  t.after(() => h.dispose()); h.recorder.onTranscript('两份', 'asr-cancel-uncertain'); await h.settle();
  const id = h.operations('evaluate')[0].body.request_id;
  h.click('cancel'); await h.settle();
  assert.ok(h.action('recover')); assert.equal(h.action('select:NX-Q1').props.disabled, true);
  h.click('recover'); await h.settle();
  assert.equal(h.reads.at(-1), `/attempts/attempt-r3/practice/${id}`);
});

test('refresh restores an unresolved transcript and the original recovery request', async t => {
  const h = harness({ evaluateResponse: () => { throw new TypeError('Connection lost'); } });
  t.after(() => h.dispose()); h.recorder.onTranscript('seven.', 'asr-refresh-uncertain'); await h.settle();
  const id = h.operations('evaluate')[0].body.request_id;
  const refreshed = harness({ sessionStorage: h.sessionStorage,
    readResponse: { status: 'applied', attempt: resultAttempt('incorrect', 'seven.') } });
  t.after(() => refreshed.dispose()); await refreshed.settle();
  assert.equal(refreshed.textOf(refreshed.transcript), 'seven.');
  assert.ok(refreshed.action('recover')); assert.equal(refreshed.action('select:NX-Q1').props.disabled, true);
  refreshed.click('recover'); await refreshed.settle();
  assert.equal(refreshed.reads.at(-1), `/attempts/attempt-r3/practice/${id}`);
  assert.equal(refreshed.result.props['data-result-status'], 'incorrect');
  assert.equal(refreshed.advances.length, 0);
});

test('a result already saved before refresh supersedes the pending local receipt', async t => {
  const h = harness({ evaluateResponse: () => { throw new TypeError('Connection lost'); } });
  t.after(() => h.dispose()); h.recorder.onTranscript('两份', 'asr-saved-before-refresh'); await h.settle();
  const id = h.operations('evaluate')[0].body.request_id;
  const saved = resultAttempt('correct', '两份'); saved.practice.result.request_id = id;
  const refreshed = harness({ attempt: saved, sessionStorage: h.sessionStorage }); t.after(() => refreshed.dispose());
  await refreshed.settle();
  assert.equal(refreshed.result.props['data-result-status'], 'correct');
  assert.equal(refreshed.action('recover'), undefined);
  assert.ok(refreshed.action('continue'));
  assert.equal(refreshed.sessionStorage.getItem('shanghai-practice-pending:attempt-r3'), null);
  assert.equal(refreshed.requests.length, 0); assert.equal(refreshed.advances.length, 0);
});

test('switching language keeps the same original transcript and updates result labels', async t => {
  const h = harness({ attempt: resultAttempt('incorrect', 'seven.') }); t.after(() => h.dispose());
  assert.match(h.text, /Incorrect · Does not match your target/);
  h.update({ locale: 'zh' }); await h.settle();
  assert.match(h.text, /不正确 · 与本题目标不符/);
  assert.doesNotMatch(h.text, /不是逐字发音评分|选择不会立即写入订单/);
  assert.doesNotMatch(h.text, /Incorrect · Does not match your target/);
  assert.equal(h.textOf(h.transcript), 'seven.');
  assert.equal(h.requests.length, 0);
});

test('editing quantity or dining choice explicitly requests only the selected designed step', async t => {
  for (const step of ['quantity', 'mode']) {
    const attempt = makeAttempt({ status: 'confirming', prompt_id: 'NX-N09' }, {
      step: 'confirm', step_id: 'confirm-step-4', target: { type: 'confirm' },
    });
    const h = harness({ attempt }); t.after(() => h.dispose()); h.click(`edit:${step}`); await h.settle();
    assert.equal(h.operations('edit').length, 1);
    const body = h.operations('edit')[0].body;
    assert.equal(body.step, step); assert.equal(body.action, undefined);
    assert.equal(h.operations('continue').length, 0);
  }
});

test('a late evaluation response after leaving cannot update the abandoned component', async t => {
  const pending = deferred(); const h = harness({ evaluateResponse: pending });
  t.after(() => h.dispose()); h.recorder.onTranscript('两份', 'asr-before-leaving'); await h.settle();
  h.dispose();
  pending.resolve({ status: 'applied', attempt: resultAttempt('correct') }); await h.settle();
  assert.equal(h.attempts.length, 0); assert.equal(h.advances.length, 0);
});

test('a stale revision preserves the original unapplied transcript across refresh', async t => {
  const newer = makeAttempt({ revision: 5, prompt_id: 'NX-N03',
    order: { item: 'xiaolongbao', quantity: 2, unit: 'serving', normalized_servings: 2, takeaway: null } },
  { step: 'mode', step_id: 'mode-step-2', target: null });
  const transcript = '  seven.  ';
  const h = harness({ evaluateResponse: () => {
    throw new h.ApiError('stale_revision', 'The question changed.', newer);
  } });
  t.after(() => h.dispose()); h.recorder.onTranscript(transcript, 'asr-before-stale-revision'); await h.settle();
  const unapplied = h.find(node => node.props?.['data-testid'] === 'practice-unapplied');
  assert.ok(unapplied);
  assert.ok(h.textOf(unapplied).includes(transcript), 'the original whitespace and words remain visible');
  assert.match(h.textOf(unapplied), /This transcript was not applied/);
  assert.equal(h.attempt.practice.step, 'mode'); assert.equal(h.attempt.order.quantity, 2);
  assert.equal(h.result, undefined); assert.equal(h.advances.length, 0);
  assert.equal(h.operations('continue').length, 0);
  const refreshed = harness({ attempt: h.attempt, sessionStorage: h.sessionStorage }); t.after(() => refreshed.dispose());
  await refreshed.settle();
  const restored = refreshed.find(node => node.props?.['data-testid'] === 'practice-unapplied');
  assert.ok(restored); assert.ok(refreshed.textOf(restored).includes(transcript));
  assert.equal(refreshed.attempt.order.quantity, 2);
  assert.equal(refreshed.advances.length, 0); assert.equal(refreshed.requests.length, 0);
});

test('empty and whitespace-only transcripts display the honest no-transcript state', t => {
  for (const transcript of ['', '   \n\t ']) {
    const h = harness({ attempt: resultAttempt('unrecognized', transcript) }); t.after(() => h.dispose());
    assert.equal(h.textOf(h.transcript), 'No transcript was received');
    assert.equal(h.transcript.props.className, 'empty');
    assert.equal(h.result.props['data-result-status'], 'unrecognized');
    assert.equal(h.attempt.practice.result.transcript, transcript, 'the stored source remains unchanged');
    assert.equal(h.advances.length, 0);
  }
});

test('a cached older continuation cannot replace newer progress or emit onAdvanced', async t => {
  const pending = deferred();
  const h = harness({ attempt: resultAttempt('correct'), continueResponse: pending }); t.after(() => h.dispose());
  h.click('continue'); await h.settle();
  const newer = resultAttempt('correct', '两份', { revision: 10 });
  h.update({ attempt: newer });
  pending.resolve({ status: 'applied', attempt: makeAttempt({ revision: 4, prompt_id: 'NX-N03' },
    { step: 'mode', step_id: 'cached-mode-step', target: null }) });
  await h.settle();
  assert.equal(h.attempt.revision, 10); assert.equal(h.attempt.practice.step, 'quantity');
  assert.equal(h.attempts.length, 0); assert.equal(h.advances.length, 0);
  assert.equal(h.action('recover'), undefined);
});

test('an evaluation response arriving after an external step change cannot overwrite the new step', async t => {
  const pending = deferred(); const h = harness({ evaluateResponse: pending }); t.after(() => h.dispose());
  h.recorder.onTranscript('  两份。 ', 'asr-before-external-update'); await h.settle();
  const newer = makeAttempt({ revision: 5, prompt_id: 'NX-N03' }, {
    step: 'mode', step_id: 'external-mode-step', target: { type: 'set_order', takeaway: true },
  });
  h.update({ attempt: newer }); await h.settle();
  pending.resolve({ status: 'applied', attempt: resultAttempt('correct', '  两份。 ') });
  await h.settle();
  assert.equal(h.attempt.revision, 5); assert.equal(h.attempt.practice.step_id, 'external-mode-step');
  assert.equal(h.attempts.length, 0); assert.equal(h.advances.length, 0);
  const unapplied = h.find(node => node.props?.['data-testid'] === 'practice-unapplied');
  assert.ok(unapplied); assert.ok(h.textOf(unapplied).includes('  两份。 '));
  assert.equal(h.result, undefined);
});

test('a retry rejected as stale displays the newest saved result for the same target', async t => {
  const saved = resultAttempt('correct', '两份', { revision: 5 });
  const h = harness({ attempt: resultAttempt('incorrect', 'seven.'), evaluateResponse: () => {
    throw new h.ApiError('stale_revision', 'Another response was already saved.', saved);
  } });
  t.after(() => h.dispose()); h.click('retry'); await h.settle();
  assert.ok(h.recorder); assert.equal(h.result, undefined);
  h.recorder.onTranscript('  两分。 ', 'asr-stale-retry'); await h.settle();
  assert.equal(h.attempt.revision, 5);
  assert.equal(h.result.props['data-result-status'], 'correct', 'retry mode cannot hide the latest authoritative result');
  assert.equal(h.textOf(h.transcript), '两份');
  assert.ok(h.action('continue')); assert.equal(h.recorder, undefined);
  assert.equal(h.advances.length, 0);
  const unapplied = h.find(node => node.props?.['data-testid'] === 'practice-unapplied');
  assert.ok(unapplied); assert.ok(h.textOf(unapplied).includes('  两分。 '));
});

test('a late API error carrying older progress cannot overwrite newer props', async t => {
  const pending = deferred(); const h = harness({ evaluateResponse: pending }); t.after(() => h.dispose());
  h.recorder.onTranscript('  两份。 ', 'asr-before-late-error'); await h.settle();
  const newer = makeAttempt({ revision: 8, prompt_id: 'NX-N03' }, {
    step: 'mode', step_id: 'newer-mode-step', target: { type: 'set_order', takeaway: false },
  });
  h.update({ attempt: newer }); await h.settle();
  pending.reject(new h.ApiError('stale_revision', 'The practice changed.', resultAttempt('correct', '两份', { revision: 4 })));
  await h.settle();
  assert.equal(h.attempt.revision, 8); assert.equal(h.attempt.practice.step_id, 'newer-mode-step');
  assert.equal(h.attempt.practice.target.takeaway, false);
  assert.equal(h.attempts.length, 0); assert.equal(h.advances.length, 0);
  assert.equal(h.result, undefined); assert.ok(h.recorder);
  const unapplied = h.find(node => node.props?.['data-testid'] === 'practice-unapplied');
  assert.ok(unapplied); assert.ok(h.textOf(unapplied).includes('  两份。 '));
});
