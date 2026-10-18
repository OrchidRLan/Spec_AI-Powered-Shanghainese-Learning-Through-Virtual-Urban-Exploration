import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UPSTREAM_REPOSITORY = 'OrchidRLan/Spec_AI-Powered-Shanghainese-Learning-Through-Virtual-Urban-Exploration';
export const FORK_REPOSITORY = 'hollis-yang/Spec-Virtual-Shanghainese-Learning';
export const RELEASE_EVENT = 'release-checked-commit';
const SHA = /^[a-f0-9]{40}$/;
const TOKEN = /^[\x21-\x7e]{20,512}$/;
const API_ORIGIN = 'https://api.github.com';
const MAIN_REF = 'refs/heads/main';

function requireRepository(repository, expectedName) {
  if (!repository || repository.full_name !== expectedName || !Number.isSafeInteger(repository.id)
    || repository.id <= 0 || repository.private !== false || repository.default_branch !== 'main'
    || repository.archived || repository.disabled) {
    throw new Error('Repository identity or main-branch configuration does not match the approved public repositories.');
  }
}

function requireSameNetwork(upstream, fork) {
  requireRepository(upstream, UPSTREAM_REPOSITORY);
  requireRepository(fork, FORK_REPOSITORY);
  const source = upstream.fork ? upstream.source : upstream;
  if (fork.fork !== true || !source || !Number.isSafeInteger(source.id) || source.id <= 0
    || fork.source?.id !== source.id || fork.source?.full_name !== source.full_name
    || upstream.id === fork.id) {
    throw new Error('The approved repositories are not in the same verified fork network.');
  }
}

function referenceSha(reference) {
  if (reference?.ref !== MAIN_REF || reference.object?.type !== 'commit' || !SHA.test(reference.object.sha)) {
    throw new Error('GitHub returned an invalid main reference.');
  }
  return reference.object.sha;
}

// The workflow runs this only after checks pass. Credentials and destinations cannot
// be supplied through a dispatch payload; the release workflow verifies freshness again.
export async function syncAndDispatch({ env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const sha = env.SYNC_SHA;
  const forkToken = env.FORK_SYNC_TOKEN;
  const readToken = env.GITHUB_TOKEN;
  if (typeof sha !== 'string' || !SHA.test(sha)) throw new Error('SYNC_SHA must be one full lowercase 40-character commit SHA.');
  if (typeof forkToken !== 'string' || !TOKEN.test(forkToken)) throw new Error('Missing or invalid FORK_SYNC_TOKEN.');
  if (readToken !== undefined && !TOKEN.test(readToken)) throw new Error('Invalid optional GITHUB_TOKEN.');
  if ((env.GITHUB_REPOSITORY && env.GITHUB_REPOSITORY !== UPSTREAM_REPOSITORY)
    || (env.GITHUB_REF && env.GITHUB_REF !== MAIN_REF)) {
    throw new Error('Synchronization must run for the approved upstream main branch.');
  }

  async function api(repository, suffix, { method = 'GET', body, expected = 200, operation } = {}) {
    // Never follow redirects or use response-provided URLs with either credential.
    const token = repository === FORK_REPOSITORY ? forkToken : readToken;
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'a-little-shanghai-release',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    };
    let response;
    try {
      response = await fetchImpl(`${API_ORIGIN}/repos/${repository}${suffix}`, {
        method, headers, redirect: 'error', signal: AbortSignal.timeout(30_000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      // Error objects and GitHub response bodies may contain secrets or request data.
      throw new Error(`${operation} failed because of a network error or timeout. No automatic retry was attempted.`);
    }
    if (response.status !== expected) {
      throw new Error(`${operation} failed (HTTP ${response.status}). No automatic retry was attempted.`);
    }
    if (expected === 204) return;
    try {
      return await response.json();
    } catch {
      throw new Error(`${operation} returned invalid JSON.`);
    }
  }

  const main = async repository => referenceSha(await api(repository, '/git/ref/heads/main', { operation: 'Reading main' }));
  const stale = () => {
    log('Upstream main has advanced. Skipping this older checked commit; no deployment was requested.');
    return { status: 'stale', sha };
  };

  const upstream = await api(UPSTREAM_REPOSITORY, '', { operation: 'Reading upstream repository' });
  const fork = await api(FORK_REPOSITORY, '', { operation: 'Reading fork repository' });
  requireSameNetwork(upstream, fork);
  if (await main(UPSTREAM_REPOSITORY) !== sha) return stale();
  const initialForkHead = await main(FORK_REPOSITORY);

  if (initialForkHead !== sha) {
    const base = encodeURIComponent(`hollis-yang:${initialForkHead}`);
    const head = encodeURIComponent(`OrchidRLan:${sha}`);
    const comparison = await api(FORK_REPOSITORY, `/compare/${base}...${head}?per_page=1`, { operation: 'Comparing fork history' });
    if (comparison.status !== 'ahead' || comparison.behind_by !== 0 || !(comparison.ahead_by > 0)
      || comparison.base_commit?.sha !== initialForkHead || comparison.merge_base_commit?.sha !== initialForkHead) {
      throw new Error('Fork main has diverged, is ahead, or its ancestry could not be verified. No update or deployment was requested.');
    }
  }

  // Recheck after the comparison. Another successful sync to this same SHA is safe;
  // other changes are left for a fresh run, never merged or overwritten here.
  if (await main(UPSTREAM_REPOSITORY) !== sha) return stale();
  const beforeUpdate = await main(FORK_REPOSITORY);
  if (beforeUpdate !== initialForkHead && beforeUpdate !== sha) {
    throw new Error('Fork main changed during synchronization. No update or deployment was requested.');
  }
  let updated = false;
  if (beforeUpdate !== sha) {
    const result = await api(FORK_REPOSITORY, '/git/refs/heads/main', {
      method: 'PATCH', body: { sha, force: false }, operation: 'Fast-forwarding fork main',
    });
    if (referenceSha(result) !== sha) throw new Error('Fork update response did not match the checked commit. Deployment was not requested.');
    updated = true;
  }

  const verifiedForkHead = await main(FORK_REPOSITORY);
  if (await main(UPSTREAM_REPOSITORY) !== sha) return stale();
  if (verifiedForkHead !== sha) throw new Error('Fork main changed before dispatch verification. Deployment was not requested.');

  // Dispatch even when already synchronized: agent publication and retries may have
  // moved main first. POST is sent once; a lost response must not trigger a blind retry.
  await api(FORK_REPOSITORY, '/dispatches', {
    method: 'POST', body: { event_type: RELEASE_EVENT, client_payload: { sha } },
    expected: 204, operation: 'Requesting the checked-commit release',
  });
  log(`Both main branches verified at ${sha}; release requested in the fork.`);
  return { status: 'dispatched', sha, updated };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('Usage: node scripts/sync-and-dispatch.mjs (configuration comes from the workflow environment).');
    await syncAndDispatch();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
