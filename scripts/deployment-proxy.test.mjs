import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import handler, { proxyRequest } from '../api/proxy.js';

const env = {
  BACKEND_URL: 'https://test-backend.example',
  BACKEND_PROXY_SECRET: 'test-only-proxy-secret-at-least-32-characters',
};
const origin = 'https://test-frontend.example';
const clientIp = '203.0.113.17';

function request(path = '/api/auth', init = {}) {
  const headers = new Headers({ 'x-vercel-forwarded-for': clientIp, 'sec-fetch-site': 'same-origin' });
  if (init.method && !['GET', 'HEAD'].includes(init.method)) {
    headers.set('origin', origin);
    headers.set('content-type', 'application/json');
  }
  for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
  return new Request(origin + path, { ...init, headers });
}

async function withBackend(t, responder) {
  const server = createServer(responder);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const localOrigin = `http://127.0.0.1:${server.address().port}`;
  return async (url, init) => {
    assert.equal(url.origin, env.BACKEND_URL);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.cache, 'no-store');
    return fetch(localOrigin + url.pathname + url.search, init);
  };
}

test('Vercel exposes a Web fetch entrypoint', () => {
  assert.equal(typeof handler.fetch, 'function');
});

test('JSON, cookies and identity headers survive a real local HTTP round trip', async (t) => {
  const source = '{ "username": "visitor", "password": "only-for-local-tests" }';
  const cookies = [
    'shanghai_session=account; Path=/; HttpOnly; Secure; SameSite=Strict',
    'legacy=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; Secure',
  ];
  const fetchImpl = await withBackend(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), source);
    assert.equal(req.url, '/api/auth/login?from=about');
    assert.equal(req.headers.origin, origin);
    assert.equal(req.headers.cookie, 'old=value');
    assert.equal(req.headers['x-guest-token'], 'guest-test-token');
    assert.equal(req.headers['x-expected-session-id'], 'session-test-id');
    assert.equal(req.headers['x-request-id'], 'request-test-id');
    assert.equal(req.headers['sec-fetch-site'], 'same-origin');
    assert.equal(req.headers['x-shanghai-proxy-secret'], env.BACKEND_PROXY_SECRET);
    assert.equal(req.headers['x-shanghai-client-ip'], clientIp);
    for (const name of ['x-forwarded-for', 'x-real-ip', 'authorization', 'x-untrusted']) {
      assert.equal(req.headers[name], undefined);
    }
    res.writeHead(200, {
      'Content-Type': 'application/json', 'Set-Cookie': cookies,
      'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*',
      'X-Shanghai-Proxy-Secret': 'must-not-leave-backend',
    });
    res.end('{"authenticated":true}');
  });
  const response = await proxyRequest(request('/api/auth/login?from=about', {
    method: 'POST', body: source, headers: {
      cookie: 'old=value', 'x-guest-token': 'guest-test-token',
      'x-expected-session-id': 'session-test-id', 'x-request-id': 'request-test-id',
      'x-shanghai-client-ip': '198.51.100.9', 'x-shanghai-proxy-secret': 'forged',
      'x-forwarded-for': '198.51.100.8', 'x-real-ip': '198.51.100.7',
      authorization: 'forged', 'x-untrusted': 'forged',
    },
  }), { env, fetchImpl });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: true });
  assert.deepEqual(response.headers.getSetCookie(), cookies);
  for (const name of ['cache-control', 'cdn-cache-control', 'vercel-cdn-cache-control']) {
    assert.equal(response.headers.get(name), 'no-store');
  }
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('x-shanghai-proxy-secret'), null);
});

test('raw WAV uploads and protected audio responses retain their exact bytes', async (t) => {
  const wav = Buffer.from([82, 73, 70, 70, 0, 255, 254, 128, 1, 0]);
  const fetchImpl = await withBackend(t, async (req, res) => {
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks), wav);
      assert.equal(req.headers['content-type'], 'audio/wav');
    } else {
      assert.equal(req.headers.range, 'bytes=0-9');
    }
    res.writeHead(req.method === 'POST' ? 200 : 206, {
      'Content-Type': 'audio/wav', 'Content-Range': 'bytes 0-9/10', 'Accept-Ranges': 'bytes',
    });
    res.end(wav);
  });
  for (const req of [
    request('/api/asr', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav }),
    request('/api/attempts/test-id/introduction/audio', { headers: { range: 'bytes=0-9' } }),
  ]) {
    const response = await proxyRequest(req, { env, fetchImpl });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), wav);
    assert.equal(response.headers.get('content-type'), 'audio/wav');
    assert.equal(response.headers.get('content-range'), 'bytes 0-9/10');
  }
});

test('cross-origin writes, missing Origin, and cross-site reads never reach the backend', async () => {
  let calls = 0;
  const fetchImpl = () => { calls++; throw new Error('Unexpected network request'); };
  const noOrigin = request('/api/auth/guest', { method: 'POST', body: '{}' });
  noOrigin.headers.delete('origin');
  for (const req of [
    noOrigin,
    request('/api/auth/guest', { method: 'POST', body: '{}', headers: { origin: 'https://untrusted.example' } }),
    request('/api/auth', { headers: { 'sec-fetch-site': 'cross-site' } }),
    request('/api/auth', { headers: { origin: 'null' } }),
  ]) {
    assert.equal((await proxyRequest(req, { env, fetchImpl })).status, 403);
  }
  assert.equal(calls, 0);
});

test('a Vercel internal HTTP hop keeps the public HTTPS origin for same-origin checks', async () => {
  const req = new Request('http://test-frontend.example/api/auth/guest', {
    method: 'POST', body: '{}', headers: {
      origin, 'x-vercel-forwarded-for': clientIp, 'x-forwarded-proto': 'https',
      'x-forwarded-host': 'attacker.example', 'content-type': 'application/json',
    },
  });
  const response = await proxyRequest(req, {
    env, fetchImpl: async (_url, init) => {
      assert.equal(init.headers.get('origin'), origin);
      assert.equal(init.headers.get('x-forwarded-host'), null);
      return Response.json({ status: 'ok' });
    },
  });
  assert.equal(response.status, 200);
  for (const protocol of ['http', 'https, http']) {
    const insecure = await proxyRequest(request('/api/auth', { headers: { 'x-forwarded-proto': protocol } }), {
      env, fetchImpl: () => assert.fail('Must not forward'),
    });
    assert.equal(insecure.status, 503);
  }
});

test('only a single Vercel-provided IP is accepted, with no fallback to caller headers', async () => {
  for (const value of ['', '203.0.113.17, 198.51.100.1', 'unknown', '203.0.113.17:123']) {
    const req = request('/api/auth', { headers: {
      'x-vercel-forwarded-for': value, 'x-shanghai-client-ip': clientIp, 'x-forwarded-for': clientIp,
    } });
    const response = await proxyRequest(req, { env, fetchImpl: () => assert.fail('Must not forward') });
    assert.equal(response.status, 503);
  }
  const response = await proxyRequest(request('/api/health', { headers: { 'x-vercel-forwarded-for': '2001:db8::1' } }), {
    env, fetchImpl: async (_url, init) => {
      assert.equal(init.headers.get('x-shanghai-client-ip'), '2001:db8::1');
      return Response.json({ status: 'ok' });
    },
  });
  assert.equal(response.status, 200);
});

test('encoded paths and out-of-API paths cannot change the fixed upstream origin', async () => {
  for (const path of ['/outside', '//attacker.example/api/auth', '/api//auth', '/api/%2f%2fattacker.example', '/api/auth%5c..', '/api/%252e%252e/private']) {
    const response = await proxyRequest(request(path), { env, fetchImpl: () => assert.fail('Must not forward') });
    assert.equal(response.status, 404, path);
  }
  await proxyRequest(request('/api/auth?url=https://attacker.example&path=//attacker.example'), {
    env, fetchImpl: async (url) => {
      assert.equal(url.origin, env.BACKEND_URL);
      assert.equal(url.pathname, '/api/auth');
      return Response.json({ status: 'ok' });
    },
  });
});

test('invalid or missing deployment configuration fails without exposing its values', async () => {
  const invalid = [
    {}, { ...env, BACKEND_PROXY_SECRET: 'short-private-value' },
    { ...env, BACKEND_URL: 'http://backend.example' },
    { ...env, BACKEND_URL: 'https://backend.example/api' },
    { ...env, BACKEND_URL: 'https://private-user:private-password@backend.example' },
    { ...env, BACKEND_URL: 'https://backend.example?secret=private-value' },
    { ...env, BACKEND_URL: origin },
  ];
  for (const configuration of invalid) {
    const response = await proxyRequest(request(), { env: configuration, fetchImpl: () => assert.fail('Must not forward') });
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.doesNotMatch(text, /private|backend\.example|test-only-proxy/);
  }
});

test('request size is bounded with and without Content-Length before forwarding', async () => {
  const response = await proxyRequest(request('/api/asr', {
    method: 'POST', body: 'small', headers: { 'content-length': String(3 * 1024 * 1024 + 1) },
  }), { env, fetchImpl: () => assert.fail('Must not forward') });
  assert.equal(response.status, 413);
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(3 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  });
  const streamed = await proxyRequest(request('/api/asr', { method: 'POST', body: stream, duplex: 'half' }), {
    env, fetchImpl: () => assert.fail('Must not forward'),
  });
  assert.equal(streamed.status, 413);
  assert.equal(cancelled, true);
});

test('upstream redirects are not followed or exposed to the caller', async (t) => {
  let calls = 0;
  const fetchImpl = await withBackend(t, (_req, res) => {
    calls++;
    res.writeHead(307, { location: '/secret-destination' });
    res.end('redirect');
  });
  const response = await proxyRequest(request(), { env, fetchImpl });
  assert.equal(calls, 1);
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('location'), null);
  assert.doesNotMatch(await response.text(), /secret-destination/);
});

test('backend failures retain their API error status while transport failures are sanitized', async () => {
  const response = await proxyRequest(request(), {
    env, fetchImpl: async () => Response.json({ detail: { code: 'session_required' } }, {
      status: 401, headers: { 'retry-after': '5' },
    }),
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('retry-after'), '5');
  assert.deepEqual(await response.json(), { detail: { code: 'session_required' } });
  const failed = await proxyRequest(request(), { env, fetchImpl: async () => { throw new Error(env.BACKEND_PROXY_SECRET); } });
  assert.equal(failed.status, 502);
  assert.doesNotMatch(await failed.text(), /test-only-proxy/);
});

test('HEAD and empty success responses have no response body', async () => {
  for (const [method, status] of [['HEAD', 200], ['POST', 204]]) {
    const response = await proxyRequest(request('/api/auth', { method }), {
      env, fetchImpl: async () => new Response(null, { status }),
    });
    assert.equal(response.status, status);
    assert.equal(response.body, null);
  }
});

test('upstream timeout aborts the network request with a retryable result', async () => {
  let aborted = false;
  const response = await proxyRequest(request(), {
    env, timeoutMs: 15, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    }),
  });
  assert.equal(response.status, 504);
  assert.equal(aborted, true);
  assert.equal((await response.json()).detail.retryable, true);
});

test('a browser disconnect cancels the upstream request', async () => {
  const controller = new AbortController();
  let aborted = false;
  const response = await proxyRequest(request('/api/asr', { method: 'POST', body: '{}', signal: controller.signal }), {
    env, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
      controller.abort();
    }),
  });
  assert.equal(aborted, true);
  assert.equal(response.status, 499);
});

test('stalled uploads and streamed responses are bounded by the same timeout', async () => {
  let uploadCancelled = false;
  const upload = new ReadableStream({ cancel() { uploadCancelled = true; } });
  const uploading = await proxyRequest(request('/api/asr', { method: 'POST', body: upload, duplex: 'half' }), {
    env, timeoutMs: 15, fetchImpl: () => assert.fail('Must not forward'),
  });
  assert.equal(uploading.status, 504);
  assert.equal(uploadCancelled, true);
  let downloadCancelled = false;
  const downloading = await proxyRequest(request(), {
    env, timeoutMs: 15, fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel() { downloadCancelled = true; },
    })),
  });
  assert.equal(downloading.status, 504);
  assert.equal(downloadCancelled, true);
});
