import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = 'https://github.com/OrchidRLan/Spec_AI-Powered-Shanghainese-Learning-Through-Virtual-Urban-Exploration.git';
const fork = 'https://github.com/hollis-yang/Spec-Virtual-Shanghainese-Learning.git';
const root = fileURLToPath(new URL('../', import.meta.url));

function canonical(url) {
  return url.replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/').replace(/\.git$/, '');
}

// Arguments are injectable for isolated local-Git tests; the CLI fixes both destinations.
export function pushAndSync({ cwd = root, sourceUrl = source, forkUrl = fork, log = console.log } = {}) {
  const git = (...args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
  const ref = 'refs/heads/main';
  let sourceVerified = false;
  try {
    if (git('branch', '--show-current') !== 'main') throw new Error('Run from main; other branches are not synchronized.');
    if (git('status', '--porcelain')) throw new Error('Working tree is not clean. Commit reviewed changes first.');
    for (const args of [['remote', 'get-url', '--all', 'origin'], ['remote', 'get-url', '--push', '--all', 'origin']]) {
      const urls = git(...args).split('\n');
      if (urls.length !== 1 || canonical(urls[0]) !== canonical(sourceUrl)) {
        throw new Error('origin must point only to the approved collaboration repository.');
      }
    }
    if (canonical(sourceUrl) === canonical(forkUrl)) throw new Error('Source and fork must be different repositories.');
    const sha = git('rev-parse', 'HEAD');
    const head = url => {
      const lines = git('ls-remote', '--exit-code', url, ref).split('\n');
      const result = lines.find(line => line.split(/\s+/)[1] === ref)?.split(/\s+/)[0];
      if (!result) throw new Error(`Cannot read main at ${url}.`);
      return result;
    };
    const push = url => git('push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no', url, `${sha}:${ref}`);
    // Explicit URLs and refspecs avoid extra push URLs, branches, tags, or forced updates.
    log(`Publishing ${sha} to the collaboration repository...`);
    push(sourceUrl);
    if (head(sourceUrl) !== sha) throw new Error('Source main changed during publication. Stop and inspect before retrying.');
    sourceVerified = true;
    log('Source verified. Synchronizing the fork...');
    head(forkUrl); // Require the existing main branch; do not silently recreate a deleted branch.
    push(forkUrl); // A normal Git push rejects both diverged and independently advanced forks.
    const sourceHead = head(sourceUrl);
    const forkHead = head(forkUrl);
    if (sourceHead !== sha || forkHead !== sha) {
      throw new Error(`Remote branches changed during verification: source=${sourceHead}, fork=${forkHead}.`);
    }
    log(`Verified: both main branches are at ${sha}.`);
    return sha;
  } catch (error) {
    const details = error.stderr?.toString().trim() || error.message;
    const state = sourceVerified
      ? 'The collaboration commit was verified, but fork synchronization is incomplete or unverified.'
      : 'Source publication is not verified; the fork was not updated by this command.';
    throw new Error(`${state}\n${details}\nNo force push or automatic conflict resolution was attempted.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('Usage: npm run git:publish (no arguments).');
    pushAndSync();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
