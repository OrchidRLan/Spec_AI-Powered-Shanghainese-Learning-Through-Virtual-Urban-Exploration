import { isIP } from 'node:net';

const REQUEST_LIMIT = 3 * 1024 * 1024;
const RESPONSE_LIMIT = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 55_000;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PATCH']);
const REQUEST_HEADERS = [
  'accept', 'content-type', 'cookie', 'origin', 'sec-fetch-site',
  'x-guest-token', 'x-expected-session-id', 'x-request-id', 'range',
];
const RESPONSE_HEADERS = ['content-type', 'content-range', 'accept-ranges', 'retry-after'];
const PRIVATE_HEADERS = {
  'cache-control': 'no-store',
  'cdn-cache-control': 'no-store',
  'vercel-cdn-cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

class ProxyProblem extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function problem(status, code, message) {
  throw new ProxyProblem(status, code, message);
}

function configuration(env) {
  let backend;
  try { backend = new URL(env.BACKEND_URL); } catch { /* Report a safe configuration error below. */ }
  const secret = env.BACKEND_PROXY_SECRET;
  // This is an operator-controlled origin, never a URL supplied by the caller.
  if (!backend || backend.protocol !== 'https:' || backend.username || backend.password
      || ![backend.origin, `${backend.origin}/`].includes(env.BACKEND_URL)
      || typeof secret !== 'string' || secret.length < 32 || secret.length > 512
      || /[^\x21-\x7e]/.test(secret)) {
    problem(503, 'backend_unavailable', 'The service is not ready. Please try again later.');
  }
  return { backend, secret };
}

async function readLimited(stream, limit, signal, tooLarge) {
  if (!stream) return undefined;
  const reader = stream.getReader();
  const chunks = [];
  let length = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        cancel();
        throw tooLarge;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, length);
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

/** Web-standard Vercel entrypoint; /api/:path* rewrites preserve the original URL. */
export async function proxyRequest(request, {
  env = process.env, fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const controller = new AbortController();
  const cancelled = new ProxyProblem(499, 'request_cancelled', 'The request was cancelled.');
  const abort = () => controller.abort(cancelled);
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) abort();
  const timer = setTimeout(() => controller.abort(new ProxyProblem(
    504, 'backend_timeout', 'The service took too long. Please try again.',
  )), timeoutMs);

  try {
    controller.signal.throwIfAborted();
    const { backend, secret } = configuration(env);
    const incoming = new URL(request.url);
    // All current API segments are ASCII identifiers. Reject encoded separators,
    // backslashes, empty segments and dot traversal before constructing the target.
    if (!/^\/api\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(incoming.pathname)) {
      problem(404, 'api_not_found', 'This API route is not available.');
    }
    if (!METHODS.has(request.method)) problem(405, 'method_not_allowed', 'This method is not available.');
    // A Node adapter may represent Vercel's internal hop as HTTP. The platform
    // supplies the original protocol; keep the original host, never a caller's
    // X-Forwarded-Host override, when checking the browser's Origin.
    const publicProtocol = request.headers.get('x-forwarded-proto') ?? incoming.protocol.slice(0, -1);
    const publicOrigin = `https://${incoming.host}`;
    if (publicProtocol !== 'https' || publicOrigin === backend.origin) {
      problem(503, 'backend_unavailable', 'The service is not ready. Please try again later.');
    }
    const origin = request.headers.get('origin');
    const writes = request.method !== 'GET' && request.method !== 'HEAD';
    if ((writes && origin !== publicOrigin) || (origin && origin !== publicOrigin)
        || request.headers.get('sec-fetch-site') === 'cross-site') {
      problem(403, 'cross_origin_denied', 'Use the application origin.');
    }
    // Vercel overwrites this header at its edge. Do not fall back to client-supplied
    // X-Forwarded-For, X-Real-IP, or X-Shanghai-Client-IP.
    const clientIp = request.headers.get('x-vercel-forwarded-for');
    if (!clientIp || !isIP(clientIp)) {
      problem(503, 'backend_unavailable', 'The service is not ready. Please try again later.');
    }
    const headers = new Headers();
    for (const name of REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set('x-shanghai-proxy-secret', secret);
    headers.set('x-shanghai-client-ip', clientIp);
    const declaredLength = request.headers.get('content-length');
    if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > REQUEST_LIMIT)) {
      problem(413, 'request_too_large', 'The request must be no larger than 3 MiB.');
    }
    const body = await readLimited(request.body, REQUEST_LIMIT, controller.signal,
      new ProxyProblem(413, 'request_too_large', 'The request must be no larger than 3 MiB.'));
    const target = new URL(incoming.pathname + incoming.search, backend.origin);
    const upstream = await fetchImpl(target, {
      method: request.method, headers, body,
      signal: controller.signal, redirect: 'manual', cache: 'no-store',
    });
    // Never follow or expose an upstream redirect carrying credentials to another host.
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();
      problem(502, 'backend_unavailable', 'The service could not complete the request. Please try again.');
    }
    const responseBody = await readLimited(upstream.body, RESPONSE_LIMIT, controller.signal,
      new ProxyProblem(502, 'backend_unavailable', 'The service response could not be loaded. Please try again.'));
    const responseHeaders = new Headers(PRIVATE_HEADERS);
    for (const name of RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) responseHeaders.set(name, value);
    }
    // Keep separate Set-Cookie values: joining them corrupts cookies with Expires.
    for (const cookie of upstream.headers.getSetCookie()) responseHeaders.append('set-cookie', cookie);
    return new Response(request.method === 'HEAD' || [204, 205].includes(upstream.status) ? null : responseBody, {
      status: upstream.status, headers: responseHeaders,
    });
  } catch (error) {
    const failure = controller.signal.aborted ? controller.signal.reason : error;
    const known = failure instanceof ProxyProblem;
    return Response.json({ detail: {
      code: known ? failure.code : 'backend_unavailable',
      message: known ? failure.message : 'The service could not be reached. Please try again.',
      retryable: !known || failure.status >= 500,
    } }, { status: known ? failure.status : 502, headers: PRIVATE_HEADERS });
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', abort);
  }
}

export default { fetch: (request) => proxyRequest(request) };
