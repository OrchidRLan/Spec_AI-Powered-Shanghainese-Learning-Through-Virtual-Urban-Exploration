import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pushAndSync } from './push-and-sync.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'shanghai-git-sync-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Sync test', '-c', 'user.email=sync@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const sourceUrl = join(dir, 'source.git');
  const forkUrl = join(dir, 'fork.git');
  const cwd = join(dir, 'work');
  git(dir, 'init', '--bare', '--initial-branch=main', sourceUrl);
  git(dir, 'init', '--bare', '--initial-branch=main', forkUrl);
  git(dir, 'clone', sourceUrl, cwd);
  const commit = (directory, name) => {
    writeFileSync(join(directory, name), name);
    git(directory, 'add', '--', name);
    git(directory, 'commit', '-m', name);
    return git(directory, 'rev-parse', 'HEAD');
  };
  const initial = commit(cwd, 'initial.txt');
  git(cwd, 'push', 'origin', 'main');
  git(cwd, 'push', forkUrl, 'main');
  const head = url => git(dir, '--git-dir', url, 'rev-parse', 'main');
  const advance = (url, name) => {
    const other = join(dir, name);
    git(dir, 'clone', url, other);
    const sha = commit(other, name + '.txt');
    git(other, 'push', 'origin', 'main');
    return sha;
  };
  return { git, cwd, sourceUrl, forkUrl, initial, head, commit, advance,
    publish: () => pushAndSync({ cwd, sourceUrl, forkUrl, log: () => {} }) };
}

test('publishes the identical commit to both main branches and can be retried', t => {
  const f = fixture(t);
  const sha = f.commit(f.cwd, 'change.txt');
  f.git(f.cwd, 'tag', 'local-only');
  assert.equal(f.publish(), sha);
  assert.equal(f.publish(), sha);
  assert.equal(f.head(f.sourceUrl), sha);
  assert.equal(f.head(f.forkUrl), sha);
  assert.equal(f.git(f.cwd, 'remote'), 'origin');
  assert.equal(f.git(f.cwd, 'ls-remote', '--tags', f.forkUrl), '');
});

test('source rejection leaves the fork unchanged', t => {
  const f = fixture(t);
  const other = f.advance(f.sourceUrl, 'source-change');
  f.commit(f.cwd, 'local-change.txt');
  assert.throws(f.publish, /Source publication is not verified/);
  assert.equal(f.head(f.sourceUrl), other);
  assert.equal(f.head(f.forkUrl), f.initial);
});

test('diverged fork is preserved after successful source publication', t => {
  const f = fixture(t);
  const other = f.advance(f.forkUrl, 'fork-change');
  const sha = f.commit(f.cwd, 'local-change.txt');
  assert.throws(f.publish, /collaboration commit was verified, but fork synchronization is incomplete/);
  assert.equal(f.head(f.sourceUrl), sha);
  assert.equal(f.head(f.forkUrl), other);
});

test('an independently advanced fork is not rewound', t => {
  const f = fixture(t);
  const other = f.advance(f.forkUrl, 'fork-change');
  assert.throws(f.publish, /fork synchronization is incomplete/);
  assert.equal(f.head(f.forkUrl), other);
});

test('uncommitted changes are not published', t => {
  const f = fixture(t);
  f.commit(f.cwd, 'committed.txt');
  writeFileSync(join(f.cwd, 'unfinished.txt'), 'unfinished');
  assert.throws(f.publish, /Working tree is not clean/);
  assert.equal(f.head(f.sourceUrl), f.initial);
  assert.equal(f.head(f.forkUrl), f.initial);
});

test('unexpected origin and extra push destinations are rejected', t => {
  const f = fixture(t);
  f.commit(f.cwd, 'change.txt');
  f.git(f.cwd, 'remote', 'set-url', 'origin', f.forkUrl);
  assert.throws(f.publish, /approved collaboration repository/);
  f.git(f.cwd, 'remote', 'set-url', 'origin', f.sourceUrl);
  f.git(f.cwd, 'remote', 'set-url', '--add', '--push', 'origin', f.sourceUrl);
  f.git(f.cwd, 'remote', 'set-url', '--add', '--push', 'origin', f.forkUrl);
  assert.throws(f.publish, /approved collaboration repository/);
  assert.equal(f.head(f.sourceUrl), f.initial);
  assert.equal(f.head(f.forkUrl), f.initial);
});

test('other branches cannot be published as main', t => {
  const f = fixture(t);
  f.git(f.cwd, 'checkout', '-b', 'unreviewed');
  f.commit(f.cwd, 'change.txt');
  assert.throws(f.publish, /Run from main/);
  assert.equal(f.head(f.sourceUrl), f.initial);
  assert.equal(f.head(f.forkUrl), f.initial);
});
