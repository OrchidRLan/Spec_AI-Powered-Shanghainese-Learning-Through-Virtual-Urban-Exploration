/** Build the Batch D site with honest pending-review content and auditable asset versions. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDeployment } from './validate-deployment.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function verifyDeploymentOutput(validation, outputRoot) {
  if (!validation.ok) throw new Error('Cannot publish an invalid content report.');
  if (!statSync(resolve(outputRoot, 'index.html')).isFile()) throw new Error('Built index.html is missing.');
  for (const asset of validation.audio.files) {
    const path = realpathSync(resolve(outputRoot, asset.file.slice(1)));
    const rel = relative(realpathSync(outputRoot), path);
    if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`Built audio escapes output: ${asset.file}`);
    const bytes = readFileSync(path);
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256 || bytes.length !== asset.bytes) {
      throw new Error(`Built audio differs from validated source: ${asset.file}`);
    }
  }
}

export function deploymentMetadata(validation, { commit, dirty = null, builtAt = new Date().toISOString() } = {}) {
  if (!validation.ok || (commit !== null && !/^[a-f0-9]{40}$/u.test(commit || ''))) throw new Error('Valid content and a valid commit (or null) are required.');
  return {
    schemaVersion: 1,
    buildMode: 'deployment-pending-acceptance',
    reviewStatus: 'pending',
    productionApproved: false,
    builtAt,
    source: { commit, dirty },
    content: validation.content,
    audio: validation.audio,
    checks: { contentIntegrity: 'passed', outputAudioIntegrity: 'passed', networkCalls: 0 },
  };
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed.`);
}

function main() {
  if (process.argv.length !== 2) throw new Error('build:deployment accepts no bypass flags.');
  console.log('Building a pending-acceptance deployment. Teaching content remains unapproved.');
  const validation = validateDeployment();
  if (!validation.ok) throw new Error(validation.errors.join('\n'));
  run('npm', ['run', 'typecheck']);
  run('npm', ['run', 'test:content']);
  run('npm', ['run', 'test:deployment-content']);
  run(process.execPath, ['node_modules/vite/bin/vite.js', 'build']);
  const output = resolve(ROOT, 'dist');
  verifyDeploymentOutput(validation, output);
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  const candidate = process.env.VERCEL_GIT_COMMIT_SHA || process.env.RENDER_GIT_COMMIT || (git.status === 0 ? git.stdout.trim() : null);
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  const metadata = deploymentMetadata(validation, { commit: candidate, dirty: status.status === 0 ? Boolean(status.stdout.trim()) : null });
  writeFileSync(resolve(output, 'deployment.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(`Pending-acceptance build verified: ${validation.audio.files.length} teaching audio files; version record: dist/deployment.json`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`Deployment build failed: ${error.message}`); process.exitCode = 1; }
}
