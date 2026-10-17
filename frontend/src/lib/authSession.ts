const GUEST_KEY = 'shanghai-guest-session';
let inMemoryGuest: string | null = null;
let identityVersion = 0;
let expectedSessionId: string | null = null;

export function bindAuthSession(id: string | null): void { expectedSessionId = id; }
const listeners = new Set<() => void>();
const requests = new Set<AbortController>();
const responseVersions = new WeakMap<Response, number>();

export function assertCurrentAuthResponse(response: Response): void {
  if (responseVersions.get(response) !== identityVersion) throw new DOMException('Identity changed', 'AbortError');
}

export function guestToken(): string | null {
  try { return sessionStorage.getItem(GUEST_KEY) || inMemoryGuest; }
  catch { return inMemoryGuest; }
}

export function setGuestToken(token: string | null): void {
  inMemoryGuest = token;
  try {
    if (token) sessionStorage.setItem(GUEST_KEY, token);
    else sessionStorage.removeItem(GUEST_KEY);
  } catch { /* A blocked store keeps this tab usable until it is refreshed. */ }
}

export function isolateAuthRequests(): void {
  identityVersion += 1;
  for (const request of requests) request.abort();
  requests.clear();
}

export function changeAuthIdentity(): void {
  isolateAuthRequests(); expectedSessionId = null;
  // Local transcripts and retry receipts belong to the previous identity.
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = sessionStorage.key(index);
      if (key && /^shanghai-(?:practice-|lesson-|speech-fallbacks|question-cursors|order-edit)/.test(key)) sessionStorage.removeItem(key);
    }
  } catch { /* Server ownership remains authoritative when storage is blocked. */ }
}

export function onAuthExpired(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** JSON and WAV requests share the same credentials and expiry boundary. */
export type AuthRequestPolicy = { guest?: 'omit'; expire?: false };
export async function authFetch(path: string, options: RequestInit = {}, policy: AuthRequestPolicy = {}): Promise<Response> {
  if(!path.startsWith('/api/')) throw new Error('Authenticated requests must use the local API');
  const version = identityVersion;
  const token = policy.guest === 'omit' ? null : guestToken();
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  requests.add(controller);
  const headers = new Headers(options.headers);
  if (token) headers.set('X-Guest-Token', token);
  if (expectedSessionId && (!/^\/api\/auth(?:\/|$)/.test(path) || path === '/api/auth/logout')) headers.set('X-Expected-Session-ID', expectedSessionId);
  try {
    const response = await fetch(path, { credentials: 'same-origin', ...options, headers, signal: controller.signal });
    if (version !== identityVersion || controller.signal.aborted) throw new DOMException('Identity changed', 'AbortError');
    if (response.status === 401) {
      const body = await response.clone().json().catch(() => null);
      if (version !== identityVersion || controller.signal.aborted) throw new DOMException('Identity changed', 'AbortError');
      if (policy.expire !== false && (body?.detail?.code === 'session_required' || body?.detail?.code === 'guest_expired' || body?.detail?.code === 'session_changed')) {
        setGuestToken(null);
        changeAuthIdentity();
        for (const listener of listeners) listener();
      }
    }
    responseVersions.set(response, version);
    return response;
  } finally {
    requests.delete(controller);
    options.signal?.removeEventListener('abort', abort);
  }
}
