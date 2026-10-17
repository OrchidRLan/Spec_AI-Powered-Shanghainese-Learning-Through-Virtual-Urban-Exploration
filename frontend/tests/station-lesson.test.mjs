import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transformWithOxc } from 'vite';

// Exercise real B+C component handlers; audio, recording and persistence are
// deterministic boundaries. No microphone or speech provider is called.
const content = JSON.parse(await readFile(new URL('../../content/batch-bc.json', import.meta.url), 'utf8'));
const source = await readFile(new URL('../src/components/StationLesson.tsx', import.meta.url), 'utf8');
const files = ['lib/stationContent.ts', 'components/StationLesson.tsx'];
const executable = (await Promise.all(files.map(async file => {
  const text = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const result = await transformWithOxc(text, file, { jsx: { runtime: 'classic' } });
  return result.code.replace(/^import\b[\s\S]*?;\n/gm, '').replace(/export default function /g, 'function ')
    .replace(/export (?=(?:function|const) )/g, '');
}))).join('\n');
const icons = source.match(/import \{([^}]+)\} from 'lucide-react'/)[1].split(',').map(name => name.trim());
const planFor = station => content.stationPlans.find(plan => plan.id === station);

function deferred() {
  let resolve; let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function storage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key) };
}
function makeAttempt(station = 'restaurant', changes = {}, lessonChanges = {}) {
  const first = planFor(station).steps[0];
  return {
    id: `attempt-${station}`, station_id: station, status: 'collecting', revision: 1,
    order: {}, unresolved_issues: [], summary_revision: null, confirmed_revision: null,
    prompt_id: first.hostEntryId, pending_request_id: null, metrics: { voice_attempts: 0, help_used: 0 },
    turns: [], created_at: '', updated_at: '', ...changes,
    lesson: { step: first.id, step_id: `${station}-${first.id}-1`, target: first.options[0].id,
      answers: {}, result: null, can_choose: false, listening: station === 'candy' ? {
        played: false, text_revealed: false, introduction_text_id: null, audio_url: '/audio/test-introduction.wav',
      } : null, ...changes.lesson, ...lessonChanges },
  };
}
function resultAttempt(status, transcript = '我勿吃辣个。', station = 'restaurant', changes = {}, lessonChanges = {}) {
  return makeAttempt(station, { revision: 3, ...changes }, {
    can_choose: status !== 'correct',
    result: { request_id: 'result-bc-1', transcript, status, reason: status === 'correct' ? 'matches_target' : 'target_mismatch',
      task_matches: true, channel: 'voice' }, ...lessonChanges,
  });
}
function finalAttempt(station = 'restaurant') {
  const step = planFor(station).steps.at(-1);
  const answers = station === 'restaurant' ? { preference: 'not_spicy', recommendation: 'recommend', dish: 'fish' }
    : station === 'candy' ? { flavor: 'mint', quantity: 'two_packs' } : { appreciation: 'good_tea' };
  return resultAttempt('correct', 'final response', station, { prompt_id: step.hostEntryId }, {
    step: step.id, step_id: `${station}-final-step`, target: step.options[0].id, answers,
  });
}
function completedResponse(attempt, requestId) {
  return { request_id: requestId, status: 'applied', attempt: {
    ...attempt, status: 'completed', revision: attempt.revision + 1, prompt_id: planFor(attempt.station_id).completionEntryId,
    lesson: { ...attempt.lesson, answers: { ...attempt.lesson.answers, [attempt.lesson.step]: attempt.lesson.target } },
  } };
}
function harness(options = {}) {
  const slots = []; const effects = []; const requests = []; const reads = [];
  const attempts = []; const busy = []; const drafts = []; const phases = []; const events = [];
  const timers = new Map(); let nextTimer = 0;
  const sessionStorage = options.sessionStorage ?? storage();
  let cursor = 0; let dirty = true; let tree; let disposed = false; let props;
  const same = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
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
    if (!same(slots[index]?.dependencies, dependencies)) {
      const slot = { dependencies, cleanup: slots[index]?.cleanup }; slots[index] = slot;
      effects.push(() => { slot.cleanup?.(); slot.cleanup = callback(); });
    }
  };
  const components = Object.fromEntries(['LearningText', 'Recorder', 'StationScene', 'DishIllustration', 'CandyIllustration', ...icons]
    .map(name => [name, function boundaryComponent() {}]));
  class ApiError extends Error {
    constructor(code, message, attempt, terminal = false) { super(message); Object.assign(this, { code, attempt, terminal }); }
  }
  const audio = { src: '', playbackRate: 1, preservesPitch: false, duration: 10, currentTime: 0, playCalls: 0, pauseCalls: 0,
    async play() { this.playCalls += 1; if (options.audioError) throw new Error('Playback unavailable'); }, pause() { this.pauseCalls += 1; } };
  const value = (response, ...args) => typeof response === 'function' ? response(...args) : response?.promise ?? response;
  const context = {
    content, ...components, useState, useRef, useEffect, ApiError, AbortController, DOMException, crypto, sessionStorage,
    document: { getElementById: () => null },
    React: { createElement: (type, attributes, ...children) => {
      if (type === 'audio' && attributes.ref) attributes.ref.current = audio;
      return { type, props: { ...attributes, children } };
    } },
    stopAllAudio: () => audio.pause(), reviewClipFor: entry => ({ file: `/audio/test-${entry.id}.wav` }),
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id),
    api: async path => { reads.push(path); if (options.readResponse) return value(options.readResponse, path); throw new Error(`Unexpected read: ${path}`); },
    post: async (path, body, signal) => {
      requests.push({ path, body, signal });
      if (path.endsWith('/cancel')) {
        if (options.cancelResponse) return value(options.cancelResponse, path, body);
        throw new Error(`Unexpected cancellation: ${path}`);
      }
      const response = options[`${body.operation}Response`] ?? options.postResponse;
      if (response) return value(response, path, body);
      if (body.operation === 'select') return { status: 'applied', request_id: body.request_id,
        attempt: makeAttempt(props.station, { ...props.attempt, revision: props.attempt.revision + 1 }, {
          ...props.attempt.lesson, target: body.option_id, result: null,
        }) };
      return new Promise(() => {});
    },
  };
  const runtime = vm.runInNewContext(`${executable}\n({ StationLesson, ActiveLesson, stationPlanFor });`, context);
  const updateAttempt = next => { attempts.push(next); props = { ...props, attempt: next }; dirty = true; };
  props = {
    station: options.station ?? 'restaurant', attempt: options.attempt ?? makeAttempt(options.station), locale: options.locale ?? 'en',
    romanization: true, asrEnabled: true, servicesReady: true, disabled: false, stopSignal: 0, audioSpeed: 1, autoVoice: false,
    onAttempt: updateAttempt, onBusyChange: value => busy.push(value), onDraftChange: value => drafts.push(value),
    onPhaseChange: value => phases.push(value), onEvent: (...args) => events.push(args), onStart() {}, onBack() {}, onSkip() {}, onReview() {}, onRomanization() {}, onSpeed() {},
    ...options.props,
  };
  function flush() {
    for (let loop = 0; dirty && loop < 40; loop += 1) {
      dirty = false; cursor = 0;
      tree = !props.attempt || props.attempt.status === 'skipped' || !props.attempt.lesson
        ? runtime.StationLesson(props) : runtime.ActiveLesson({ ...props, plan: runtime.stationPlanFor(props.station) });
      while (effects.length) effects.shift()();
    }
    assert.equal(dirty, false, 'station lesson effects settled');
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
  const action = name => find(node => node.props?.['data-lesson-action'] === name);
  flush();
  return {
    requests, reads, attempts, busy, drafts, phases, events, sessionStorage, audio, find, action, textOf: text, ApiError,
    get text() { return text(); }, get attempt() { return props.attempt; },
    get recorder() { return find(node => node.type === components.Recorder)?.props; },
    get result() { return find(node => node.props?.['data-testid'] === 'lesson-result'); },
    get transcript() { return find(node => node.props?.['data-testid'] === 'lesson-transcript'); },
    get audioNode() { return find(node => node.type === 'audio')?.props; },
    get scene() { return find(node => node.type === components.StationScene)?.props; },
    operations(operation) { return requests.filter(request => request.body?.operation === operation); },
    click(name) {
      const button = action(name); assert.ok(button, `action exists: ${name}`); assert.ok(!button.props.disabled, `action enabled: ${name}`);
      button.props.onClick(); flush();
    },
    audioEvent(name) { this.audioNode[name](); flush(); },
    update(next) { props = { ...props, ...next }; dirty = true; flush(); },
    runTimers(delay) { const matches = [...timers.entries()].filter(([, item]) => delay === undefined || item.delay === delay); for (const [id, item] of matches) { timers.delete(id); item.callback(); } flush(); },
    async settle() { for (let index = 0; index < 30; index += 1) { await Promise.resolve(); if (!disposed) flush(); } },
    dispose() { disposed = true; for (const slot of slots) slot?.cleanup?.(); },
  };
}

test('B+C selecting a target saves only the target and waits for speech before continuation', async t => {
  for (const station of ['restaurant', 'teahouse']) {
    const h = harness({ station, attempt: makeAttempt(station, {}, { target: null }) }); t.after(() => h.dispose());
    assert.equal(h.recorder, undefined);
    h.click(`select:${planFor(station).steps[0].options[0].id}`); await h.settle();
    assert.equal(h.operations('select').length, 1); assert.ok(h.recorder);
    assert.equal(h.operations('continue').length, 0); assert.deepEqual(h.attempt.lesson.answers, {});
    assert.equal(h.action('assisted'), undefined, 'first speaking attempt remains required');
  }
});

test('B+C correct and incorrect evaluations always display the exact transcript without advancing', async t => {
  for (const locale of ['zh', 'en']) for (const status of ['correct', 'incorrect']) {
    const transcript = status === 'correct' ? '  我勿吃辣个。  ' : 'unrelated reply';
    const h = harness({ locale, evaluateResponse: { status: 'applied', attempt: resultAttempt(status, transcript) } }); t.after(() => h.dispose());
    const callback = h.recorder.onTranscript; callback(transcript, 'asr-bc-original'); callback(transcript, 'asr-bc-original'); await h.settle();
    assert.equal(h.operations('evaluate').length, 1);
    assert.equal(h.operations('evaluate')[0].body.text, transcript);
    assert.equal(h.operations('evaluate')[0].body.asr_request_id, 'asr-bc-original');
    assert.equal(h.result.props['data-result-status'], status); assert.equal(h.textOf(h.transcript), transcript);
    assert.equal(h.operations('continue').length, 0); assert.equal(h.attempt.lesson.step, 'preference');
    assert.match(h.text, locale === 'zh' ? /识别结果/ : /Recognized words/);
    assert.match(h.text, status === 'correct' ? locale === 'zh' ? /正确 · 符合/ : /Correct · Matches/ : locale === 'zh' ? /不正确 · 与/ : /Incorrect · Does not/);
    assert.doesNotMatch(h.text, /This checks the expression|Task completion is not|your local recording is not stored/);
  }
});

test('B+C only explicit Next commits progress, and double activation sends a single continuation', async t => {
  const pending = deferred();
  const h = harness({ attempt: resultAttempt('correct'), continueResponse: pending }); t.after(() => h.dispose());
  const callback = h.action('continue').props.onClick; h.click('continue'); callback(); await h.settle();
  assert.equal(h.operations('continue').length, 1); assert.equal(h.attempt.lesson.step, 'preference');
  assert.equal(h.operations('continue')[0].body.result_request_id, 'result-bc-1');
  assert.equal(h.operations('continue')[0].body.assisted, false);
  pending.resolve({ status: 'applied', attempt: makeAttempt('restaurant', { revision: 4, prompt_id: 'BC-OLD-ASK-RECOMMENDATION' }, {
    step: 'recommendation', step_id: 'recommendation-step-2', target: null, answers: { preference: 'not_spicy' },
  }) }); await h.settle();
  assert.equal(h.attempt.lesson.step, 'recommendation'); assert.equal(h.result, undefined); assert.equal(h.recorder, undefined);
});

test('B+C recognition and technical failures show a result and permit explicitly assisted continuation', async t => {
  for (const reason of ['recognition', 'technical']) {
    const attempt = resultAttempt(reason === 'recognition' ? 'unrecognized' : 'technical', null);
    const h = harness({ evaluateResponse: { status: 'applied', attempt } }); t.after(() => h.dispose());
    h.recorder.onFailure(reason, { requestId: `asr-${reason}` }); await h.settle();
    assert.equal(h.operations('evaluate')[0].body.failure_kind, reason);
    assert.equal(h.operations('evaluate')[0].body.asr_request_id, `asr-${reason}`);
    assert.match(h.textOf(h.transcript), /No transcript/); assert.equal(h.action('continue'), undefined);
    h.click('assisted'); await h.settle();
    assert.equal(h.operations('continue')[0].body.assisted, true);
  }
});

test('a task-incompatible dish or flavor cannot bypass its task through assisted continuation or retry', async t => {
  for (const station of ['restaurant', 'candy']) {
    const step = station === 'restaurant' ? 'dish' : 'flavor';
    const attempt = resultAttempt('incorrect', 'wrong task', station, {}, {
      step, step_id: `${step}-1`, target: station === 'restaurant' ? 'tofu' : 'mint',
      listening: { played: true, text_revealed: false, audio_url: '/audio/intro.wav' },
      result: { request_id: 'task-failure', status: 'incorrect', transcript: 'wrong task', task_matches: false, reason: station === 'restaurant' ? 'spicy_dish' : 'wrong_flavor' },
    });
    const h = harness({ station, attempt }); t.after(() => h.dispose());
    assert.equal(h.action('assisted'), undefined);
    h.click('retry'); assert.ok(h.recorder); assert.equal(h.action('assisted'), undefined);
    assert.match(h.text, station === 'restaurant' ? /Choose a dish/ : /Listen and choose a flavor/);
  }
});

test('candy starts with equal choices locked and no introduction text or target clue', async t => {
  const h = harness({ station: 'candy', attempt: makeAttempt('candy', {}, { target: null }) }); t.after(() => h.dispose());
  for (const flavor of ['rose', 'osmanthus', 'mint']) {
    assert.equal(h.action(`select:${flavor}`).props.disabled, true);
    assert.equal(h.action(`select:${flavor}`).props['aria-pressed'], false);
  }
  assert.equal(h.recorder, undefined);
  assert.equal(h.find(node => node.props?.entry?.id?.startsWith('BC-CND-INTRO-')), undefined);
  h.runTimers(); await h.settle(); assert.equal(h.audio.playCalls, 0, 'the hidden introduction does not auto-play or reveal its text');
});

test('candy listens only after a started introduction ends, not at play, error or interrupted stop', async t => {
  const h = harness({ station: 'candy' }); t.after(() => h.dispose());
  h.click('listen'); await h.settle();
  assert.equal(h.operations('listened').length, 0);
  h.audioEvent('onPlay'); assert.equal(h.operations('listened').length, 0);
  h.audioEvent('onError'); h.audioEvent('onEnded'); await h.settle();
  assert.equal(h.operations('listened').length, 0, 'a failed clip is not counted as listened');
  h.click('listen'); await h.settle(); h.audioEvent('onPlay'); h.update({ stopSignal: 1 }); h.audioEvent('onEnded'); await h.settle();
  assert.equal(h.operations('listened').length, 0, 'leaving or stopping invalidates an unfinished clip');
  h.click('listen'); await h.settle(); h.audioEvent('onPlay'); h.audioEvent('onEnded'); h.audioEvent('onEnded'); await h.settle();
  assert.equal(h.operations('listened').length, 1, 'one successful ended event records the listening fact once');
  assert.equal(h.action('select:rose').props.disabled, true, 'selection waits for the saved listening receipt');
});

test('candy rejected playback remains locked and explicit text help unlocks only after save', async t => {
  const saved = makeAttempt('candy', { revision: 2 }, { target: null, listening: {
    played: false, text_revealed: true, introduction_text_id: 'BC-CND-INTRO-ROSE', audio_url: '/audio/intro.wav',
  } });
  const pending = deferred();
  const h = harness({ station: 'candy', audioError: true, helpResponse: pending }); t.after(() => h.dispose());
  h.click('listen'); await h.settle(); assert.equal(h.operations('listened').length, 0); assert.match(h.text, /Audio could not play/);
  assert.equal(h.action('select:rose').props.disabled, true);
  h.click('help'); await h.settle(); assert.equal(h.operations('help').length, 1);
  assert.equal(h.find(node => node.props?.entry?.id === 'BC-CND-INTRO-ROSE'), undefined);
  pending.resolve({ status: 'applied', attempt: saved }); await h.settle();
  assert.ok(h.find(node => node.props?.entry?.id === 'BC-CND-INTRO-ROSE'));
  for (const flavor of ['rose', 'osmanthus', 'mint']) assert.equal(h.action(`select:${flavor}`).props.disabled, false);
  assert.equal(h.attempt.lesson.listening.played, false, 'text help is never reclassified as listening');
});

test('pending evaluation survives refresh, shows raw text and blocks new answers until recovered', async t => {
  const transcript = '  我要清蒸鱼。 ';
  const attempt = makeAttempt('restaurant', {}, { step: 'dish', step_id: 'dish-2', target: 'fish' });
  const pending = { requestId: 'unknown-evaluation', operation: 'evaluate', stepId: 'dish-2', transcript, expectedRevision: 1, target: 'fish' };
  const saved = resultAttempt('correct', transcript, 'restaurant', {}, { step: 'dish', step_id: 'dish-2', target: 'fish', result: {
    request_id: 'unknown-evaluation', transcript, status: 'correct', task_matches: true,
  } });
  const memory = storage({ [`shanghai-lesson-pending:${attempt.id}`]: JSON.stringify(pending) });
  const h = harness({ attempt, sessionStorage: memory, readResponse: { status: 'applied', attempt: saved } }); t.after(() => h.dispose());
  assert.equal(h.result.props['data-result-status'], 'pending'); assert.equal(h.textOf(h.transcript), transcript);
  assert.equal(h.recorder, undefined); assert.equal(h.action('select:chicken').props.disabled, true);
  h.click('recover'); await h.settle();
  assert.equal(h.reads[0], '/attempts/attempt-restaurant/lesson/unknown-evaluation');
  assert.equal(h.result.props['data-result-status'], 'correct');
  assert.equal(h.operations('continue').length, 0); assert.equal(memory.getItem(`shanghai-lesson-pending:${attempt.id}`), null);
});

test('cancelled unknown evaluations clear their receipt without applying an answer', async t => {
  const attempt = makeAttempt();
  const memory = storage({ [`shanghai-lesson-pending:${attempt.id}`]: JSON.stringify({
    requestId: 'cancel-me', operation: 'evaluate', stepId: attempt.lesson.step_id, transcript: 'old response', expectedRevision: 1, target: attempt.lesson.target,
  }) });
  const h = harness({ attempt, sessionStorage: memory, cancelResponse: { status: 'cancelled', attempt } }); t.after(() => h.dispose());
  h.click('cancel'); await h.settle();
  assert.equal(h.requests[0].path, '/attempts/attempt-restaurant/lesson/cancel-me/cancel');
  assert.equal(h.requests[0].body.expected_revision, 1);
  assert.equal(h.result, undefined); assert.ok(h.recorder); assert.match(h.text, /Cancelled/);
  assert.deepEqual(h.attempt.lesson.answers, {}); assert.equal(h.operations('continue').length, 0);
});

test('unknown save failure retains its recovery lock while a terminal conflict refreshes saved state', async t => {
  const h = harness({ evaluateResponse: () => { throw new TypeError('Network response lost'); } }); t.after(() => h.dispose());
  h.recorder.onTranscript('我勿吃辣个', 'asr-network'); await h.settle();
  assert.equal(h.result.props['data-result-status'], 'pending'); assert.ok(h.action('recover')); assert.ok(h.action('cancel'));
  assert.equal(h.action('select:not_spicy').props.disabled, true);
  const newer = makeAttempt('restaurant', { revision: 8 }, { target: null, step: 'recommendation', step_id: 'new-step' });
  let error;
  const conflict = harness({ evaluateResponse: () => { throw error; } }); t.after(() => conflict.dispose());
  error = new conflict.ApiError('stale_revision', 'Changed elsewhere', newer);
  conflict.recorder.onTranscript('我勿吃辣个', 'asr-conflict'); await conflict.settle();
  assert.equal(conflict.attempt.revision, 8); assert.equal(conflict.attempt.lesson.step, 'recommendation');
  assert.equal(conflict.action('recover'), undefined); assert.match(conflict.text, /were not applied/);
  assert.equal(conflict.operations('continue').length, 0);
});

test('late recorder and evaluation responses cannot overwrite a newer target or step', async t => {
  const response = deferred(); const h = harness({ evaluateResponse: response }); t.after(() => h.dispose());
  const oldRecorder = h.recorder; oldRecorder.onTranscript('我勿吃辣个', 'asr-old'); await h.settle();
  const newer = makeAttempt('restaurant', { revision: 7, prompt_id: 'BC-OLD-ASK-RECOMMENDATION' }, { step: 'recommendation', step_id: 'recommendation-7', target: 'recommend' });
  h.update({ attempt: newer });
  response.resolve({ status: 'applied', attempt: resultAttempt('correct') }); await h.settle();
  assert.equal(h.attempt.revision, 7); assert.equal(h.attempts.length, 0); assert.equal(h.result, undefined);
  oldRecorder.onTranscript('late words', 'asr-too-late'); oldRecorder.onFailure('recognition'); await h.settle();
  assert.equal(h.operations('evaluate').length, 1);
  assert.match(h.text, /were not applied/);
});

test('unmounted lessons abort requests and ignore their eventual responses', async () => {
  const pending = deferred(); const h = harness({ evaluateResponse: pending });
  h.recorder.onTranscript('我勿吃辣个', 'asr-disposed'); await h.settle(); h.dispose();
  assert.equal(h.operations('evaluate')[0].signal.aborted, true);
  pending.resolve({ status: 'applied', attempt: resultAttempt('correct') }); await h.settle();
  assert.equal(h.attempts.length, 0);
});

test('teahouse finishes after thanks without adding an order-confirmation question', async t => {
  for (const locale of ['zh', 'en']) {
    const attempt = resultAttempt('correct', '谢谢侬', 'teahouse', { prompt_id: 'BC-TEA-RESPONSE' }, {
      step: 'thanks', step_id: 'thanks-2', target: 'thanks', answers: { appreciation: 'good_tea' },
    });
    const pending = deferred(); const h = harness({ station: 'teahouse', locale, attempt, continueResponse: pending }); t.after(() => h.dispose());
    assert.equal(h.textOf(h.action('continue')), locale === 'zh' ? '完成这次品茶' : 'Finish this tea visit');
    assert.equal(h.find(node => node.props?.['data-lesson-step'] === 'confirm'), undefined);
    assert.equal(h.find(node => node.props?.className === 'r1-completed bc-completed'), undefined);
    h.click('continue'); await h.settle();
    assert.equal(h.attempt.status, 'collecting');
    pending.resolve({ status: 'applied', attempt: makeAttempt('teahouse', { status: 'completed', revision: 4, prompt_id: 'BC-TEA-COMPLETE' }, {
      step: 'thanks', step_id: 'thanks-2', target: 'thanks', answers: { appreciation: 'good_tea', thanks: 'thanks' },
    }) }); await h.settle();
    assert.equal(h.attempt.status, 'completed'); assert.ok(h.find(node => node.props?.className === 'r1-completed bc-completed'));
    assert.match(h.text, locale === 'zh' ? /回顾这一站/ : /Review this stop/); assert.equal(h.recorder, undefined);
  }
});

test('B+C normal and slow playback preserve pitch; an active recorder blocks sentence playback', async t => {
  const h = harness(); t.after(() => h.dispose());
  h.update({ audioSpeed: 0.75 }); assert.equal(h.audio.playbackRate, 0.75); assert.equal(h.audio.preservesPitch, true);
  h.update({ audioSpeed: 1 }); assert.equal(h.audio.playbackRate, 1);
  h.recorder.onPhaseChange('recording'); await h.settle();
  const button = h.find(node => node.props?.className?.startsWith('sentence-listen'));
  assert.equal(button.props.disabled, true);
});

test('an unanswered mutation times out into recovery and never applies its late response', async t => {
  const response = deferred(); const attempt = makeAttempt();
  const h = harness({ evaluateResponse: response, readResponse: { status: 'applied', attempt: resultAttempt('correct', '我勿吃辣个。') } }); t.after(() => h.dispose());
  h.recorder.onTranscript('我勿吃辣个。', 'asr-timeout'); await h.settle();
  assert.equal(h.action('recover'), undefined); assert.match(h.text, /Saving/);
  h.runTimers(12000); await h.settle();
  assert.equal(h.operations('evaluate')[0].signal.aborted, true);
  assert.ok(h.action('recover')); assert.ok(h.action('cancel')); assert.equal(h.attempts.length, 0);
  response.resolve({ status: 'applied', attempt: resultAttempt('correct', 'late data') }); await h.settle();
  assert.equal(h.attempts.length, 0, 'the unresolved original call cannot overwrite an explicit recovery');
  h.click('recover'); await h.settle();
  assert.equal(h.result.props['data-result-status'], 'correct'); assert.equal(h.textOf(h.transcript), '我勿吃辣个。');
  assert.equal(h.operations('continue').length, 0);
});

test('a receipt for a different target preserves its transcript outside the current result', async t => {
  const attempt = makeAttempt('restaurant', { revision: 5 }, { step: 'dish', step_id: 'dish-2', target: 'chicken' });
  const transcript = '  我要清蒸鱼。 ';
  const memory = storage({ [`shanghai-lesson-pending:${attempt.id}`]: JSON.stringify({
    requestId: 'older-fish', operation: 'evaluate', stepId: 'dish-2', transcript, expectedRevision: 4, target: 'fish',
  }) });
  const h = harness({ attempt, sessionStorage: memory }); t.after(() => h.dispose());
  assert.equal(h.result, undefined); assert.match(h.text, /were not applied/); assert.ok(h.text.includes(transcript));
  assert.equal(memory.getItem(`shanghai-lesson-unapplied:${attempt.id}`), transcript);
  assert.equal(h.operations('continue').length, 0);
});

test('restaurant and candy confirmation speech follows the complete saved choice after edits', async t => {
  for (const station of ['restaurant', 'candy']) {
    const field = station === 'restaurant' ? 'dish' : 'flavor';
    const choices = station === 'restaurant' ? ['fish', 'chicken'] : ['rose', 'osmanthus', 'mint'];
    const step = planFor(station).steps.find(item => item.id === 'confirm');
    const answers = station === 'restaurant' ? { preference: 'not_spicy', recommendation: 'recommend' } : { quantity: 'two_packs' };
    const h = harness({ station, attempt: makeAttempt(station, { prompt_id: null }, {
      step: 'confirm', step_id: 'confirm-1', target: 'confirm', answers: { ...answers, [field]: choices[0] },
    }) }); t.after(() => h.dispose());
    for (let index = 0; index < choices.length; index += 1) {
      const answer = choices[index];
      h.update({ attempt: makeAttempt(station, { revision: index + 2, prompt_id: null }, {
        step: 'confirm', step_id: `confirm-${index + 2}`, target: 'confirm', answers: { ...answers, [field]: answer },
      }) });
      assert.ok(h.find(node => node.props?.entry?.id === step.summaryEntryIds[answer]), `${answer} has its complete matching confirmation`);
      for (const other of choices.filter(item => item !== answer)) {
        assert.equal(h.find(node => node.props?.entry?.id === step.summaryEntryIds[other]), undefined);
      }
      const sentence = content.entries.find(item => item.id === step.summaryEntryIds[answer]);
      const playback = h.find(node => node.type === 'button' && node.props?.['aria-label'] === `Listen to ${sentence.hanzi}`);
      assert.ok(playback); playback.props.onClick(); await h.settle();
      assert.equal(h.audio.src, `/audio/test-${sentence.id}.wav`);
    }
    h.click(`edit:${field}`); await h.settle();
    assert.equal(h.operations('edit')[0].body.step, field, 'editing requests only the existing designed step');
    assert.equal(h.operations('continue').length, 0);
  }
});

test('each B+C final Continue plays its saved closing line once and returns the host to a completed pose', async t => {
  for (const station of ['restaurant', 'candy', 'teahouse']) {
    const attempt = finalAttempt(station); const response = deferred();
    const h = harness({ station, attempt, continueResponse: response, props: { autoVoice: true, audioSpeed: 0.75 } }); t.after(() => h.dispose());
    h.runTimers(); await h.settle(); assert.equal(h.audio.playCalls, 0, 'the retained final result does not re-read the question');
    h.click('continue'); await h.settle();
    const receipt = h.operations('continue')[0];
    assert.equal(h.audio.playCalls, 0, 'completion waits for a successful save');
    response.resolve(completedResponse(attempt, receipt.body.request_id)); await h.settle();
    assert.equal(h.attempt.lesson.step_id, attempt.lesson.step_id, 'completion retains the final question identity');
    assert.ok(h.attempt.lesson.result, 'a retained assessment must not suppress the closing line');
    assert.equal(h.audio.playCalls, 1); assert.equal(h.audio.src, `/audio/test-${planFor(station).completionEntryId}.wav`);
    assert.equal(h.audio.playbackRate, 0.75); assert.equal(h.audio.preservesPitch, true);
    h.audioEvent('onPlay'); assert.equal(h.scene.pose, 'speaking'); assert.equal(h.scene.completed, true);
    assert.match(h.text, /Your host is speaking/);
    const completePanel = h.find(node => node.props?.className === 'r1-completed bc-completed');
    const buttons = completePanel.props.children.flat(Infinity).find(node => node?.props?.className?.includes('completed-actions')).props.children;
    assert.ok(buttons.every(button => !button.props.disabled), 'completion navigation stays available during the closing line');
    h.audioEvent('onEnded'); assert.equal(h.scene.pose, 'packed');
    h.update({ attempt: { ...h.attempt }, locale: 'zh' }); h.runTimers(); await h.settle();
    assert.equal(h.audio.playCalls, 1, 'rerendering, language changes and later timers never repeat the closing line');
    const sentence = content.entries.find(entry => entry.id === planFor(station).completionEntryId);
    h.find(node => node.type === 'button' && node.props?.['aria-label'] === `试听 ${sentence.hanzi}`).props.onClick(); await h.settle();
    assert.equal(h.audio.playCalls, 2, 'manual replay remains available');
  }
});

test('restored completion and a saved receipt recovered after remount never auto-play a closing line', async t => {
  const attempt = finalAttempt(); const done = completedResponse(attempt, 'old-completion');
  const restored = harness({ attempt: done.attempt, props: { autoVoice: true } }); t.after(() => restored.dispose());
  restored.runTimers(); await restored.settle(); assert.equal(restored.audio.playCalls, 0);
  restored.update({ autoVoice: false }); restored.update({ autoVoice: true }); restored.runTimers(); await restored.settle();
  assert.equal(restored.audio.playCalls, 0);
  const memory = storage({ [`shanghai-lesson-pending:${attempt.id}`]: JSON.stringify({ requestId: done.request_id,
    operation: 'continue', stepId: attempt.lesson.step_id, expectedRevision: attempt.revision, target: attempt.lesson.target, transcript: null,
  }) });
  const recovered = harness({ attempt, sessionStorage: memory, readResponse: done, props: { autoVoice: true } }); t.after(() => recovered.dispose());
  recovered.click('recover'); await recovered.settle(); recovered.runTimers(); await recovered.settle();
  assert.equal(recovered.attempt.status, 'completed'); assert.equal(recovered.audio.playCalls, 0, 'recovery restores state without replaying a prior visit');
});

test('a local completion with a lost response can play once after confirmed recovery, never from its late response', async t => {
  const attempt = finalAttempt(); const late = deferred(); let receipt;
  const h = harness({ attempt, continueResponse: late, readResponse: () => completedResponse(attempt, receipt.body.request_id), props: { autoVoice: true } }); t.after(() => h.dispose());
  h.click('continue'); await h.settle(); receipt = h.operations('continue')[0];
  h.runTimers(12000); await h.settle();
  assert.equal(h.audio.playCalls, 0); assert.equal(h.attempt.status, 'collecting');
  h.click('recover'); await h.settle(); assert.equal(h.audio.playCalls, 1);
  late.resolve(completedResponse(attempt, receipt.body.request_id)); await h.settle(); h.runTimers(); await h.settle();
  assert.equal(h.audio.playCalls, 1); assert.equal(h.attempts.length, 1);
});

test('host-audio off, navigation stops and a rejected save cannot trigger an automatic closing line', async t => {
  for (const interrupt of ['off', 'stop', 'unmount', 'cancel', 'conflict']) {
    const attempt = finalAttempt(); const response = deferred(); let conflict;
    const h = harness({ attempt, continueResponse: interrupt === 'conflict' ? () => { throw conflict; } : response,
      cancelResponse: (_path, _body) => ({ request_id: h.operations('continue')[0].body.request_id, status: 'cancelled', attempt }),
      props: { autoVoice: true } }); t.after(() => { if (interrupt !== 'unmount') h.dispose(); });
    if(interrupt === 'conflict') conflict = new h.ApiError('stale_revision', 'Already changed', completedResponse(attempt, 'other-visit').attempt);
    h.click('continue'); await h.settle(); const receipt = h.operations('continue')[0];
    if(interrupt === 'off') h.update({ autoVoice: false });
    if(interrupt === 'stop') h.update({ stopSignal: 1 });
    if(interrupt === 'unmount') h.dispose();
    if(interrupt === 'cancel') { h.runTimers(12000); await h.settle(); h.click('cancel'); await h.settle(); }
    response.resolve(completedResponse(attempt, receipt.body.request_id)); await h.settle();
    if(interrupt !== 'unmount') { h.update({ autoVoice: true }); h.runTimers(); await h.settle(); }
    assert.equal(h.audio.playCalls, 0, `${interrupt} must not announce an unconfirmed or interrupted completion`);
  }
});

test('closing playback waits for the save lock to release and a rejected audio play never loops', async t => {
  const attempt = finalAttempt(); const response = deferred();
  const h = harness({ attempt, continueResponse: response, audioError: true, props: { autoVoice: true } }); t.after(() => h.dispose());
  h.click('continue'); await h.settle(); h.update({ disabled: true });
  response.resolve(completedResponse(attempt, h.operations('continue')[0].body.request_id)); await h.settle();
  assert.equal(h.audio.playCalls, 0, 'wait for the parent save lock');
  h.update({ disabled: false }); await h.settle();
  assert.equal(h.audio.playCalls, 1); assert.match(h.text, /Audio could not play/);
  h.runTimers(); h.update({ attempt: { ...h.attempt } }); await h.settle();
  assert.equal(h.audio.playCalls, 1); assert.equal(h.scene.pose, 'packed');
  const pauses = h.audio.pauseCalls; h.update({ stopSignal: 1 }); assert.ok(h.audio.pauseCalls > pauses, 'stop signals stop the shared audio channel');
});

test('completed station illustrations retain the speaking pose during their closing line', async () => {
  const sceneSource = await readFile(new URL('../src/components/StationScenes.tsx', import.meta.url), 'utf8');
  const transformed = await transformWithOxc(sceneSource, 'StationScenes.tsx', { jsx: { runtime: 'classic' } });
  const code = transformed.code.replace(/^import\b[\s\S]*?;\n/gm, '').replace(/export (?=(?:function|const) )/g, '');
  const runtime = vm.runInNewContext(`${code}\n({ StationScene });`, {
    useId: () => 'scene-test', React: { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) },
  });
  for (const station of ['restaurant', 'candy', 'teahouse']) {
    assert.equal(runtime.StationScene({ station, completed: true, pose: 'speaking' }).props['data-pose'], 'speaking');
    assert.equal(runtime.StationScene({ station, completed: true, pose: 'idle' }).props['data-pose'], 'packed');
  }
});
