import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRelease, FORK_REPO } from './resolve-release.mjs';

const sha = 'a'.repeat(40);
const env = { RELEASE_SHA: sha, GITHUB_REPOSITORY: FORK_REPO,
  GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'repository_dispatch' };
const branch = value => new Response(JSON.stringify({ ref: 'refs/heads/main', object: { type: 'commit', sha: value } }));

test('release requires the exact SHA in both repositories', async () => {
  const calls = [];
  assert.deepEqual(await resolveRelease({ env, log() {}, fetchImpl: async url => { calls.push(url); return branch(sha); } }), { sha, ready: true });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(url => url.startsWith('https://api.github.com/repos/')));
});
test('a queued old release is skipped after either main advances', async () => {
  for (const advancedIndex of [0, 1]) {
    let call = 0;
    assert.deepEqual(await resolveRelease({ env, log() {}, fetchImpl: async () => branch(call++ === advancedIndex ? 'b'.repeat(40) : sha) }), { sha, ready: false });
  }
});
test('rejects arbitrary refs, repositories, and untrusted SHA strings before network access', async () => {
  for (const override of [{ RELEASE_SHA: 'main' }, { RELEASE_SHA: '$(echo unsafe)' }, { GITHUB_REPOSITORY: 'other/repo' },
    { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_EVENT_NAME: 'push' }]) {
    await assert.rejects(resolveRelease({ env: { ...env, ...override }, fetchImpl() { assert.fail('Must not request'); } }));
  }
});
test('fails closed on invalid responses without exposing API response bodies', async () => {
  for (const fetchImpl of [async () => new Response('secret-body', { status: 403 }), async () => new Response('not-json'),
    async () => new Response('{}'), async () => { throw new Error('secret-network-error'); }]) {
    await assert.rejects(resolveRelease({ env, fetchImpl }), error => !error.message.includes('secret'));
  }
});
