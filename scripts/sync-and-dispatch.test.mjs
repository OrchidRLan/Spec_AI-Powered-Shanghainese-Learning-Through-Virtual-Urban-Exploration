import assert from 'node:assert/strict';
import test from 'node:test';
import { FORK_REPOSITORY, RELEASE_EVENT, UPSTREAM_REPOSITORY, syncAndDispatch } from './sync-and-dispatch.mjs';

const target = 'b'.repeat(40);
const previous = 'a'.repeat(40);
const newer = 'c'.repeat(40);
const forkToken = 'github_pat_TEST_FORK_SECRET_NOT_REAL';
const readToken = 'ghs_TEST_READ_TOKEN_NOT_REAL';
const reference = sha => ({ ref: 'refs/heads/main', object: { type: 'commit', sha } });

function harness(options = {}) {
  const calls = [];
  const logs = [];
  const upstreamHeads = [...(options.upstreamHeads ?? [target, target, target])];
  const forkHeads = [...(options.forkHeads ?? [previous, previous, target])];
  const upstream = { id: 101, full_name: UPSTREAM_REPOSITORY, private: false, default_branch: 'main', fork: false, ...options.upstream };
  const fork = { id: 102, full_name: FORK_REPOSITORY, private: false, default_branch: 'main', fork: true, source: { id: 101, full_name: UPSTREAM_REPOSITORY }, ...options.fork };
  const env = { SYNC_SHA: target, FORK_SYNC_TOKEN: forkToken, GITHUB_TOKEN: readToken, GITHUB_REPOSITORY: UPSTREAM_REPOSITORY, GITHUB_REF: 'refs/heads/main', ...options.env };
  const fetchImpl = async (url, init) => {
    const request = { url, ...init, json: init.body === undefined ? undefined : JSON.parse(init.body) };
    calls.push(request);
    assert.equal(new URL(url).origin, 'https://api.github.com');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    const suffix = url.replace('https://api.github.com/repos/', '');
    let body;
    let status = 200;
    if (options.intercept) {
      const replacement = await options.intercept(request);
      if (replacement !== undefined) return replacement;
    }
    if (suffix === UPSTREAM_REPOSITORY) body = upstream;
    else if (suffix === FORK_REPOSITORY) body = fork;
    else if (suffix === `${UPSTREAM_REPOSITORY}/git/ref/heads/main`) body = reference(upstreamHeads.shift());
    else if (suffix === `${FORK_REPOSITORY}/git/ref/heads/main`) body = reference(forkHeads.shift());
    else if (suffix.startsWith(`${FORK_REPOSITORY}/compare/`)) body = {
      status: 'ahead', ahead_by: 3, behind_by: 0, base_commit: { sha: previous }, merge_base_commit: { sha: previous },
      // A workflow change is synchronized as the original commit, without stripping files.
      files: [{ filename: '.github/workflows/release.yml', status: 'modified' }],
      ...options.comparison,
    };
    else if (suffix === `${FORK_REPOSITORY}/git/refs/heads/main` && init.method === 'PATCH') body = reference(target);
    else if (suffix === `${FORK_REPOSITORY}/dispatches` && init.method === 'POST') status = 204;
    else assert.fail(`Unexpected mocked request ${init.method} ${suffix}`);
    return { status, json: async () => body };
  };
  return { calls, logs, run: () => syncAndDispatch({ env, fetchImpl, log: value => logs.push(value) }) };
}

const writes = h => h.calls.filter(call => call.method !== 'GET');

test('fast-forwards the exact checked commit, verifies both branches, then dispatches once', async () => {
  const h = harness();
  assert.deepEqual(await h.run(), { status: 'dispatched', sha: target, updated: true });
  assert.deepEqual(writes(h).map(({ method, json }) => ({ method, json })), [
    { method: 'PATCH', json: { sha: target, force: false } },
    { method: 'POST', json: { event_type: RELEASE_EVENT, client_payload: { sha: target } } },
  ]);
  const patch = h.calls.findIndex(call => call.method === 'PATCH');
  assert.deepEqual(h.calls.slice(patch + 1, -1).map(call => call.url), [
    `https://api.github.com/repos/${FORK_REPOSITORY}/git/ref/heads/main`,
    `https://api.github.com/repos/${UPSTREAM_REPOSITORY}/git/ref/heads/main`,
  ]);
  assert.ok(h.calls.some(call => call.url.endsWith(`/compare/hollis-yang%3A${previous}...OrchidRLan%3A${target}?per_page=1`)));
  for (const call of h.calls) {
    assert.equal(call.headers.Authorization, `Bearer ${call.url.includes(`/repos/${FORK_REPOSITORY}`) ? forkToken : readToken}`);
  }
  assert.ok(h.logs.every(line => !line.includes(forkToken) && !line.includes(readToken)));
});

test('already synchronized main still dispatches, supporting prior git:publish and explicit retries', async () => {
  const h = harness({ forkHeads: [target, target, target] });
  assert.deepEqual(await h.run(), { status: 'dispatched', sha: target, updated: false });
  assert.deepEqual(writes(h).map(call => call.method), ['POST']);
  assert.ok(!h.calls.some(call => call.url.includes('/compare/')));
});

test('a concurrent successful update to the same commit skips PATCH and dispatches after verification', async () => {
  const h = harness({ forkHeads: [previous, target, target] });
  assert.equal((await h.run()).updated, false);
  assert.deepEqual(writes(h).map(call => call.method), ['POST']);
});

for (const [name, upstreamHeads, writeMethods] of [
  ['before comparison', [newer], []],
  ['during comparison', [target, newer], []],
  ['after safe fork update', [target, target, newer], ['PATCH']],
]) {
  test(`upstream advancement ${name} skips stale deployment`, async () => {
    const h = harness({ upstreamHeads });
    assert.deepEqual(await h.run(), { status: 'stale', sha: target });
    assert.deepEqual(writes(h).map(call => call.method), writeMethods);
  });
}

for (const comparison of [
  { status: 'diverged', behind_by: 2 },
  { status: 'behind', ahead_by: 0, behind_by: 2 },
  { merge_base_commit: { sha: newer } },
  { base_commit: { sha: newer } },
]) {
  test(`rejects unsafe or inconsistent ancestry ${JSON.stringify(comparison)}`, async () => {
    const h = harness({ comparison });
    await assert.rejects(h.run(), /ancestry could not be verified/);
    assert.deepEqual(writes(h), []);
  });
}

test('fork advancement during comparison is never overwritten', async () => {
  const h = harness({ forkHeads: [previous, newer] });
  await assert.rejects(h.run(), /changed during synchronization/);
  assert.deepEqual(writes(h), []);
});

test('fork change after PATCH prevents dispatch', async () => {
  const h = harness({ forkHeads: [previous, previous, newer] });
  await assert.rejects(h.run(), /changed before dispatch verification/);
  assert.deepEqual(writes(h).map(call => call.method), ['PATCH']);
});

test('a mismatched PATCH response prevents dispatch and is never retried', async () => {
  const h = harness({ intercept: call => call.method === 'PATCH' ? { status: 200, json: async () => reference(newer) } : undefined });
  await assert.rejects(h.run(), /update response did not match/);
  assert.deepEqual(writes(h).map(call => call.method), ['PATCH']);
});

test('a server-side fast-forward conflict stops without retry or dispatch', async () => {
  const h = harness({ intercept: call => call.method === 'PATCH' ? { status: 422 } : undefined });
  await assert.rejects(h.run(), /Fast-forwarding fork main failed \(HTTP 422\)/);
  assert.deepEqual(writes(h).map(call => call.method), ['PATCH']);
});

test('missing workflow permission fails closed; no alternative commit or author rewrite', async () => {
  const h = harness({ intercept: call => call.method === 'PATCH' ? { status: 403, json: async () => ({ message: 'workflow permission needed' }) } : undefined });
  await assert.rejects(h.run(), /HTTP 403/);
  assert.deepEqual(writes(h).map(call => call.json), [{ sha: target, force: false }]);
});

test('dispatch timeout is reported once without retrying the mutating POST or logging request data', async () => {
  const h = harness({ intercept: call => { if (call.method === 'POST') throw new Error(`request failed ${forkToken}`); } });
  await assert.rejects(h.run(), error => /Requesting the checked-commit release failed/.test(error.message) && !error.message.includes(forkToken));
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
});

test('HTTP failures expose only status, never the upstream error body', async () => {
  const h = harness({ intercept: () => ({ status: 401, json: async () => { throw new Error(forkToken); } }) });
  await assert.rejects(h.run(), error => /HTTP 401/.test(error.message) && !error.message.includes(forkToken));
  assert.equal(h.calls.length, 1);
});

test('unrelated fork metadata is rejected before branch reads or mutations', async () => {
  const h = harness({ fork: { source: { id: 999, full_name: 'other/repository' } } });
  await assert.rejects(h.run(), /same verified fork network/);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(writes(h), []);
});

test('renamed repository or changed default branch is rejected', async () => {
  for (const upstream of [{ full_name: 'another/repository' }, { default_branch: 'development' }]) {
    const h = harness({ upstream });
    await assert.rejects(h.run(), /identity or main-branch configuration/);
    assert.deepEqual(writes(h), []);
  }
});

test('invalid SHA, missing or unsafe credentials, and wrong workflow context make no requests', async () => {
  for (const env of [
    { SYNC_SHA: 'main' }, { SYNC_SHA: '../main' }, { SYNC_SHA: 'B'.repeat(40) },
    { FORK_SYNC_TOKEN: undefined }, { FORK_SYNC_TOKEN: 'secret\nunsafe-header' },
    { GITHUB_TOKEN: 'secret\nunsafe-header' },
    { GITHUB_REPOSITORY: FORK_REPOSITORY }, { GITHUB_REF: 'refs/heads/feature' },
  ]) {
    const h = harness({ env });
    await assert.rejects(h.run());
    assert.equal(h.calls.length, 0);
  }
});

test('optional upstream token can be omitted; fork credential is never sent to upstream', async () => {
  const h = harness({ env: { GITHUB_TOKEN: undefined } });
  await h.run();
  for (const call of h.calls.filter(call => call.url.includes(`/repos/${UPSTREAM_REPOSITORY}`))) {
    assert.equal(call.headers.Authorization, undefined);
  }
});

test('invalid reference and invalid JSON responses fail closed', async () => {
  for (const response of [
    { status: 200, json: async () => ({ ref: 'refs/heads/other', object: { type: 'commit', sha: target } }) },
    { status: 200, json: async () => { throw new SyntaxError('private response content'); } },
  ]) {
    const h = harness({ intercept: call => call.url.includes('/git/ref/') ? response : undefined });
    await assert.rejects(h.run(), /invalid main reference|invalid JSON/);
    assert.deepEqual(writes(h), []);
  }
});
