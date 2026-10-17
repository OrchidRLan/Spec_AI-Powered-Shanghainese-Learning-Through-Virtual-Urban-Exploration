import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transformWithOxc } from 'vite';

// Exercise the component's actual handlers with deterministic browser/media
// boundaries. These tests never open a microphone or contact a speech provider.
const source = await readFile(new URL('../src/components/Recorder.tsx', import.meta.url), 'utf8');
const transformed = await transformWithOxc(source, 'Recorder.tsx', { jsx: { runtime: 'classic' } });
const executable = transformed.code.replace(/^import\b[\s\S]*?;\n/gm, '')
  .replace('export default function Recorder', 'function Recorder');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness(options = {}) {
  const slots = [];
  const effects = [];
  const documentEvents = new Map();
  const windowEvents = new Map();
  const transcripts = [];
  const failures = [];
  const failureDetails = [];
  const requests = [];
  const events = [];
  let cursor = 0;
  let dirty = true;
  let tree;
  let activeRecorder;
  let stoppedTracks = 0;
  let mediaRequests = 0;
  let disposed = false;
  let props = {
    locale: 'en', enabled: true, resetSignal: 0, stopSignal: 0,
    onTranscript: (text, id) => transcripts.push({ text, id }),
    onFailure: (reason, detail) => {
      failures.push(reason);
      failureDetails.push({ message: detail?.message, requestId: detail?.requestId });
    }, onEvent: name => events.push(name),
    ...options.props,
  };
  const dependenciesMatch = (left, right) => left && right && left.length === right.length
    && left.every((value, index) => Object.is(value, right[index]));
  const useRef = initial => {
    const index = cursor++;
    return slots[index] ??= { current: initial };
  };
  const useState = initial => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], value => {
      const next = typeof value === 'function' ? value(slots[index]) : value;
      if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true; }
    }];
  };
  const useCallback = (callback, dependencies) => {
    const index = cursor++;
    if (!dependenciesMatch(slots[index]?.dependencies, dependencies)) slots[index] = { callback, dependencies };
    return slots[index].callback;
  };
  const useEffect = (callback, dependencies) => {
    const index = cursor++;
    if (!dependenciesMatch(slots[index]?.dependencies, dependencies)) {
      const previous = slots[index];
      const slot = { dependencies, cleanup: previous?.cleanup };
      slots[index] = slot;
      effects.push(() => { slot.cleanup?.(); slot.cleanup = callback(); });
    }
  };
  const stream = { getTracks: () => [{ stop: () => { stoppedTracks += 1; } }] };
  class MockMediaRecorder {
    state = 'inactive';
    mimeType = 'audio/webm';
    static isTypeSupported() { return true; }
    constructor() { activeRecorder = this; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob([options.emptyAudio ? '' : 'synthetic-test-audio']) });
        this.onstop?.();
      });
    }
  }
  const document = {
    hidden: false,
    addEventListener: (name, callback) => documentEvents.set(name, callback),
    removeEventListener: name => documentEvents.delete(name),
  };
  const icon = () => null;
  const context = {
    useRef, useState, useCallback, useEffect,
    React: { createElement: (type, attributes, ...children) => ({ type, props: { ...attributes, children } }) },
    Mic: icon, RotateCcw: icon, Square: icon, X: icon,
    chooseRecordingMimeType: () => 'audio/webm', MAX_RECORDING_SECONDS: 20, stopAllAudio: () => {},
    recordingToWav: options.convert ?? (async () => new ArrayBuffer(48)),
    navigator: { mediaDevices: { getUserMedia: async () => {
      mediaRequests += 1;
      if (options.microphoneError) throw options.microphoneError;
      return options.microphone?.promise ?? stream;
    } } },
    MediaRecorder: MockMediaRecorder, HTMLMediaElement: class {}, document,
    window: { addEventListener: (name, callback) => windowEvents.set(name, callback), removeEventListener: name => windowEvents.delete(name) },
    fetch: async (url, request) => {
      requests.push({ url, request });
      if (options.response) return options.response.promise;
      return { ok: true, json: async () => ({ text: options.text ?? '两份', request_id: 'asr-test-id' }) };
    },
    Blob, URL, AbortController, DOMException, crypto, performance, setInterval, clearInterval, setTimeout, clearTimeout,
  };
  const Recorder = vm.runInNewContext(`${executable}\nRecorder;`, context);
  function flush() {
    for (let loop = 0; dirty && loop < 30; loop += 1) {
      dirty = false; cursor = 0; tree = Recorder(props);
      while (effects.length) effects.shift()();
    }
    assert.equal(dirty, false, 'component effects settled');
  }
  function elements(node = tree) {
    if (!node || typeof node !== 'object') return [];
    return [node, ...(node.props?.children ?? []).flat(Infinity).flatMap(child => elements(child))];
  }
  function text(node) {
    if (typeof node === 'string') return node;
    if (!node || typeof node !== 'object') return '';
    return (node.props?.children ?? []).flat(Infinity).map(text).join('');
  }
  flush();
  return {
    transcripts, failures, failureDetails, requests, events,
    get stoppedTracks() { return stoppedTracks; },
    get mediaRequests() { return mediaRequests; },
    get text() { return text(tree); },
    click(label) {
      const button = elements().find(node => node.type === 'button' && text(node) === label);
      assert.ok(button, `button exists: ${label}`);
      assert.ok(!button.props.disabled, `button enabled: ${label}`);
      button.props.onClick(); flush();
    },
    update(next) { props = { ...props, ...next }; dirty = true; flush(); },
    hide() { document.hidden = true; documentEvents.get('visibilitychange')?.(); flush(); },
    failRecording() { activeRecorder.onerror(); flush(); },
    async settle() {
      for (let index = 0; index < 12; index += 1) { await Promise.resolve(); if (!disposed) flush(); }
    },
    dispose() {
      disposed = true;
      for (const slot of slots) slot?.cleanup?.();
    },
    stream,
  };
}

async function recordAndStop(h) {
  h.click('Tap to speak'); await h.settle();
  h.click('Stop recording'); await h.settle();
}

test('a user stop automatically transcribes once and sends the original transcript', async t => {
  const h = harness({ text: '  我要两份。 ' }); t.after(() => h.dispose());
  assert.equal(h.mediaRequests, 0, 'mounting never opens the microphone');
  await recordAndStop(h);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.transcripts, [{ text: '  我要两份。 ', id: 'asr-test-id' }]);
  assert.deepEqual(h.failures, []);
  assert.ok(h.stoppedTracks > 0);
  assert.match(h.text, /Review your result before continuing/);
  assert.doesNotMatch(h.text, /Send for transcription|not stored long term|use this reply|sends your answer/);
});

test('empty audio and empty recognized text unlock recognition fallback', async t => {
  for (const options of [{ emptyAudio: true }, { text: ' ' }]) {
    const h = harness(options); t.after(() => h.dispose());
    await recordAndStop(h);
    assert.deepEqual(h.failures, ['recognition']);
    assert.deepEqual(h.transcripts, []);
  }
});

test('microphone rejection and unavailable service unlock technical fallback', async t => {
  const permission = harness({ microphoneError: new DOMException('Denied', 'NotAllowedError') });
  t.after(() => permission.dispose());
  permission.click('Tap to speak'); await permission.settle();
  assert.deepEqual(permission.failures, ['technical']);
  assert.match(permission.failureDetails[0].message, /Microphone permission is off/);
  assert.equal(permission.failureDetails[0].requestId, undefined);
  assert.equal(permission.requests.length, 0);
  const unavailable = harness({ props: { enabled: false } }); t.after(() => unavailable.dispose());
  assert.deepEqual(unavailable.failures, ['technical']);
  unavailable.update({ resetSignal: 1 });
  assert.deepEqual(unavailable.failures, ['technical', 'technical']);
  assert.equal(unavailable.mediaRequests, 0);
});

test('conversion and provider errors are technical failures, never pronunciation failures', async t => {
  const conversion = harness({ convert: async () => { throw new Error('bad codec'); } });
  t.after(() => conversion.dispose());
  await recordAndStop(conversion);
  assert.deepEqual(conversion.failures, ['technical']);
  assert.match(conversion.failureDetails[0].message, /could not be converted/);
  assert.equal(conversion.failureDetails[0].requestId, undefined);
  assert.equal(conversion.requests.length, 0);
  const response = deferred(); const provider = harness({ response }); t.after(() => provider.dispose());
  await recordAndStop(provider);
  response.resolve({ ok: false, status: 503, json: async () => ({ detail: { code: 'unavailable' } }) });
  await provider.settle();
  assert.deepEqual(provider.failures, ['technical']);
  assert.equal(provider.failureDetails[0].requestId, provider.requests[0].request.headers['X-Request-ID']);
});

test('provider no_speech is a recognition failure', async t => {
  const response = deferred(); const h = harness({ response }); t.after(() => h.dispose());
  await recordAndStop(h);
  response.resolve({ ok: false, status: 422, json: async () => ({ detail: { code: 'no_speech', terminal: true, retryable: true } }) });
  await h.settle();
  assert.deepEqual(h.failures, ['recognition']);
  assert.match(h.failureDetails[0].message, /No clear words were recognized/);
  assert.equal(h.failureDetails[0].requestId, h.requests[0].request.headers['X-Request-ID'],
    'terminal failures retain the attempt ID even after the retry ID was cleared');
  assert.deepEqual(h.transcripts, []);
});

test('unavailable service reports a localized reason without a stale request ID or callback loop', async t => {
  const h = harness(); t.after(() => h.dispose());
  await recordAndStop(h);
  assert.equal(h.requests.length, 1);
  h.update({ enabled: false, locale: 'zh' });
  assert.deepEqual(h.failures, ['technical']);
  assert.deepEqual(h.failureDetails, [{
    message: '语音识别待连接，仍可本地回听或选择回应。', requestId: undefined,
  }]);
  assert.match(h.text, /停止后自动识别，查看结果后再继续/);
  assert.doesNotMatch(h.text, /自动识别并回答/);
  const laterCalls = [];
  h.update({ onFailure: (...args) => laterCalls.push(args) });
  h.update({ disabled: true });
  assert.equal(laterCalls.length, 0, 'a new callback or parent render does not report the same outage again');
  h.update({ resetSignal: 1 });
  assert.equal(laterCalls.length, 1, 'a newly selected question receives its own availability result');
  assert.equal(laterCalls[0][1].requestId, undefined);
});

test('cancelling capture never uploads or unlocks fallback', async t => {
  const h = harness(); t.after(() => h.dispose());
  h.click('Tap to speak'); await h.settle(); h.click('Cancel'); await h.settle();
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.failures, []);
  assert.deepEqual(h.transcripts, []);
});

test('backgrounding, language changes and stop signals stop capture without uploading', async t => {
  for (const interrupt of [h => h.hide(), h => h.update({ locale: 'zh' }), h => h.update({ stopSignal: 1 })]) {
    const h = harness(); t.after(() => h.dispose());
    h.click('Tap to speak'); await h.settle(); interrupt(h); await h.settle();
    assert.equal(h.requests.length, 0);
    assert.deepEqual(h.failures, []);
    assert.deepEqual(h.transcripts, []);
    assert.ok(h.stoppedTracks > 0);
  }
});

test('late transcription after cancel, reset, language change or unmount cannot answer', async t => {
  for (const interrupt of [h => h.click('Cancel transcription'), h => h.update({ resetSignal: 1 }), h => h.update({ locale: 'zh' }), h => h.dispose()]) {
    const response = deferred(); const h = harness({ response }); t.after(() => h.dispose());
    await recordAndStop(h); interrupt(h);
    assert.equal(h.requests[0].request.signal.aborted, true);
    response.resolve({ ok: true, json: async () => ({ text: '两份', request_id: 'late-asr' }) });
    await h.settle();
    assert.deepEqual(h.transcripts, []);
    assert.deepEqual(h.failures, []);
  }
});

test('a late permission result after reset releases the microphone and never records', async t => {
  const microphone = deferred(); const h = harness({ microphone }); t.after(() => h.dispose());
  h.click('Tap to speak'); h.update({ resetSignal: 1 });
  microphone.resolve(h.stream); await h.settle();
  assert.ok(h.stoppedTracks > 0);
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.failures, []);
  assert.doesNotMatch(h.text, /Stop recording/);
});

test('switching question during conversion prevents the upload', async t => {
  const conversion = deferred(); const h = harness({ convert: () => conversion.promise }); t.after(() => h.dispose());
  await recordAndStop(h); h.update({ resetSignal: 1 });
  conversion.resolve(new ArrayBuffer(48)); await h.settle();
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.transcripts, []);
  assert.deepEqual(h.failures, []);
});

test('a late recognition failure cannot unlock choices in the next question', async t => {
  const response = deferred(); const h = harness({ response }); t.after(() => h.dispose());
  await recordAndStop(h); h.update({ resetSignal: 1 });
  response.resolve({ ok: false, status: 422, json: async () => ({ detail: { code: 'no_speech' } }) });
  await h.settle();
  assert.deepEqual(h.failures, []);
  assert.deepEqual(h.transcripts, []);
});
