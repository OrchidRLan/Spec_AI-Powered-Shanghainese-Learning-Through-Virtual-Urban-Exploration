import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE_REPO = 'OrchidRLan/Spec_AI-Powered-Shanghainese-Learning-Through-Virtual-Urban-Exploration';
export const FORK_REPO = 'hollis-yang/Spec-Virtual-Shanghainese-Learning';

// A dispatched SHA is data, never shell code or an unchecked checkout reference.
export async function resolveRelease({ env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const sha = env.RELEASE_SHA;
  if (!/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('RELEASE_SHA must be a full lowercase commit SHA.');
  if (env.GITHUB_REPOSITORY !== FORK_REPO || env.GITHUB_REF !== 'refs/heads/main'
      || !['repository_dispatch', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)) {
    throw new Error('Production releases only run on the deployment fork main branch.');
  }
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  for (const repo of [SOURCE_REPO, FORK_REPO]) {
    let response;
    try {
      response = await fetchImpl(`https://api.github.com/repos/${repo}/git/ref/heads/main`, {
        headers, redirect: 'error', signal: AbortSignal.timeout(20_000),
      });
    } catch { throw new Error('Cannot read the release branch from GitHub.'); }
    if (!response.ok) throw new Error(`GitHub release-branch check failed (HTTP ${response.status}).`);
    let data;
    try { data = await response.json(); } catch { throw new Error('GitHub returned invalid branch metadata.'); }
    if (data.ref !== 'refs/heads/main' || data.object?.type !== 'commit'
        || !/^[a-f0-9]{40}$/.test(data.object?.sha || '')) throw new Error('GitHub returned invalid branch metadata.');
    if (data.object.sha !== sha) {
      log('Release skipped: the requested commit is no longer current main in both repositories.');
      return { sha, ready: false };
    }
  }
  log(`Verified release candidate ${sha}.`);
  return { sha, ready: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('This script accepts configuration only through environment variables.');
    const result = await resolveRelease();
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sha=${result.sha}\nready=${result.ready}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### Release selection\n\nCommit: \`${result.sha}\`\n\n${result.ready ? 'Current main verified in both repositories.' : 'Skipped because main advanced or the repositories are not synchronized.'}\n`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
