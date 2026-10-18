/** Deploy one checked commit, backend first. Never retry a deployment POST or restore a database. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TARGET = Object.freeze({
  repository: 'hollis-yang/Spec-Virtual-Shanghainese-Learning',
  repositoryId: '1423608435',
  branch: 'main',
  renderServiceId: 'srv-db9vmreq1p3s739p3p30',
  renderName: 'a-little-shanghai-api',
  backendOrigin: 'https://a-little-shanghai-api.onrender.com',
  vercelName: 'spec-virtual-shanghainese-learning',
  frontendOrigin: 'https://spec-virtual-shanghainese-learning.vercel.app',
});
const RENDER_PENDING = new Set(['created', 'queued', 'build_in_progress', 'pre_deploy_in_progress', 'update_in_progress']);
const RENDER_FAILED = new Set(['build_failed', 'pre_deploy_failed', 'update_failed', 'canceled', 'deactivated']);
const VERCEL_PENDING = new Set(['QUEUED', 'INITIALIZING', 'BUILDING']);
const VERCEL_FAILED = new Set(['ERROR', 'CANCELED', 'BLOCKED']);
const SHA = /^[a-f0-9]{40}$/u;

export class ReleaseError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = 'ReleaseError';
    this.retryable = retryable;
  }
}

function requireCondition(condition, message) {
  if (!condition) throw new ReleaseError(message);
}

export function releaseConfiguration(env) {
  for (const name of ['RELEASE_SHA', 'RENDER_API_KEY', 'VERCEL_TOKEN', 'RENDER_SERVICE_ID', 'VERCEL_PROJECT_ID']) {
    requireCondition(typeof env[name] === 'string' && env[name].trim().length > 0, `Missing ${name}.`);
  }
  requireCondition(SHA.test(env.RELEASE_SHA), 'RELEASE_SHA must be a full lowercase commit SHA.');
  requireCondition(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === TARGET.repository
    && env.GITHUB_REPOSITORY_ID === TARGET.repositoryId && env.GITHUB_REF === 'refs/heads/main'
    && ['repository_dispatch', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME),
  'Production release is restricted to the fork main dispatch workflow.');
  requireCondition(env.RENDER_SERVICE_ID === TARGET.renderServiceId, 'Unexpected Render service ID.');
  requireCondition(/^prj_[a-zA-Z0-9]+$/u.test(env.VERCEL_PROJECT_ID), 'Invalid Vercel project ID.');
  requireCondition(!env.VERCEL_TEAM_ID || /^team_[a-zA-Z0-9]+$/u.test(env.VERCEL_TEAM_ID), 'Invalid Vercel team ID.');
  for (const name of ['RENDER_API_KEY', 'VERCEL_TOKEN']) {
    requireCondition(/^[\x21-\x7e]+$/u.test(env[name]), `Invalid ${name}.`);
  }
  return { sha: env.RELEASE_SHA, renderKey: env.RENDER_API_KEY, vercelToken: env.VERCEL_TOKEN,
    projectId: env.VERCEL_PROJECT_ID, teamId: env.VERCEL_TEAM_ID || null };
}

export function localReleaseSource() {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const vercel = JSON.parse(readFileSync(resolve(ROOT, 'vercel.json'), 'utf8'));
    const rules = readFileSync(resolve(ROOT, 'backend/app/rules.py'), 'utf8');
    const contentVersion = rules.match(/^CONTENT_VERSION = "([^"\r\n]+)"$/mu)?.[1];
    const ruleVersion = rules.match(/^RULE_VERSION = "([^"\r\n]+)"$/mu)?.[1];
    requireCondition(contentVersion && ruleVersion, 'Cannot determine the checked backend versions.');
    return { head, automaticGitDeployment: vercel.git?.deploymentEnabled,
      contentVersion, ruleVersion };
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    throw new ReleaseError('Cannot read the checked release source.');
  }
}

/** All external requests have fixed origins, no redirect following, bounded reads, and redacted errors. */
function client({ config, fetchImpl, requestTimeoutMs }) {
  return async function request(platform, path, { method = 'GET', body } = {}) {
    const origin = platform === 'render' ? 'https://api.render.com' : platform === 'vercel'
      ? 'https://api.vercel.com' : platform === 'backend' ? TARGET.backendOrigin : TARGET.frontendOrigin;
    const url = new URL(path, origin);
    requireCondition(url.origin === origin, 'Request origin mismatch.');
    if (platform === 'vercel' && config.teamId) url.searchParams.set('teamId', config.teamId);
    const headers = { Accept: 'application/json', 'Cache-Control': 'no-cache' };
    if (platform === 'render') headers.Authorization = `Bearer ${config.renderKey}`;
    if (platform === 'vercel') headers.Authorization = `Bearer ${config.vercelToken}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', signal: controller.signal });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ReleaseError(`${platform} ${method} failed with HTTP ${response.status}.`,
          { retryable: method === 'GET' && (response.status === 429 || response.status >= 500) });
      }
      const reader = response.body?.getReader();
      requireCondition(reader, `${platform} ${method} returned no JSON body.`);
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) {
          await reader.cancel();
          throw new ReleaseError(`${platform} ${method} response exceeded the size limit.`);
        }
        chunks.push(value);
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new ReleaseError(`${platform} ${method} returned invalid JSON.`); }
    } catch (error) {
      if (error instanceof ReleaseError) throw error;
      // Fetch errors may contain URLs, echoed headers or third-party response text. Do not print them.
      throw new ReleaseError(`${platform} ${method} request failed or timed out.${method === 'POST'
        ? ' Outcome may be unknown; inspect the platform before rerunning. No POST retry was made.' : ''}`,
      { retryable: method === 'GET' });
    } finally { clearTimeout(timer); }
  };
}

function verifyRenderService(service) {
  requireCondition(service?.id === TARGET.renderServiceId && service.name === TARGET.renderName
    && service.type === 'web_service' && service.branch === TARGET.branch
    && [`https://github.com/${TARGET.repository}`, `https://github.com/${TARGET.repository}.git`].includes(service.repo)
    && service.serviceDetails?.url === TARGET.backendOrigin,
  'Render service identity or source does not match the production target.');
  requireCondition(service.autoDeploy === 'no' && (!service.autoDeployTrigger || service.autoDeployTrigger === 'off'),
    'Render native automatic deployment must remain off.');
  requireCondition(service.suspended === 'not_suspended', 'Render service is suspended.');
}

function verifyVercelProject(project, config) {
  requireCondition(project?.id === config.projectId && project.name === TARGET.vercelName
    && project.link?.type === 'github' && String(project.link.repoId) === TARGET.repositoryId
    && project.link.org === 'hollis-yang' && project.link.repo === 'Spec-Virtual-Shanghainese-Learning'
    && project.link.productionBranch === TARGET.branch,
  'Vercel project identity or source does not match the production target.');
  if (config.teamId) requireCondition(project.accountId === config.teamId, 'Vercel project team does not match.');
  // gitProviderOptions.createDeployments controls GitHub status records, not automatic Vercel builds.
  // Automatic Vercel builds are disabled in this exact commit's vercel.json, checked before requests.
}

function verifyHealth(health, source) {
  return health?.status === 'ok' && health.mode === 'production'
    && health.content_version === source.contentVersion && health.rule_version === source.ruleVersion;
}

function verifyVercelDeployment(deployment, config, id) {
  requireCondition(deployment?.id === id && deployment.projectId === config.projectId
    && deployment.target === 'production', 'Vercel deployment identity or target mismatch.');
  const git = deployment.gitSource;
  requireCondition(git?.type === 'github' && String(git.repoId) === TARGET.repositoryId
    && git.ref === TARGET.branch && git.sha === config.sha,
  'Vercel deployment source commit mismatch.');
}

export async function releaseProduction({ env = process.env, fetchImpl = globalThis.fetch,
  sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)), now = Date.now,
  log = message => console.log(message), readSource = localReleaseSource,
  requestTimeoutMs = 30_000, pollIntervalMs = 15_000, deployTimeoutMs = 20 * 60_000,
  verifyTimeoutMs = 2 * 60_000 } = {}) {
  const config = releaseConfiguration(env);
  const source = readSource();
  requireCondition(source.head === config.sha, 'Checked-out commit differs from RELEASE_SHA.');
  requireCondition(source.automaticGitDeployment === false, 'vercel.json must disable native automatic Git deployments.');
  requireCondition(typeof source.contentVersion === 'string' && typeof source.ruleVersion === 'string',
    'Missing checked backend versions.');
  const request = client({ config, fetchImpl, requestTimeoutMs });
  const renderPath = `/v1/services/${TARGET.renderServiceId}`;
  const projectPath = `/v9/projects/${config.projectId}`;
  const poll = async (label, timeout, inspect) => {
    const deadline = now() + timeout;
    let previous = '';
    while (now() < deadline) {
      let result;
      try { result = await inspect(); }
      catch (error) {
        if (!(error instanceof ReleaseError) || !error.retryable) throw error;
        result = { state: 'temporary read failure' };
      }
      if (result.done) return result.value;
      if (result.state !== previous) { log(`${label}: ${result.state}.`); previous = result.state; }
      const remaining = deadline - now();
      if (remaining > 0) await sleep(Math.min(pollIntervalMs, remaining));
    }
    throw new ReleaseError(`${label} timed out. Check the platform before starting another release; no rollback was attempted.`);
  };

  // Both credentials and both target identities are checked before the first production mutation.
  const preflight = await Promise.allSettled([request('render', renderPath), request('vercel', projectPath)]);
  for (const result of preflight) if (result.status === 'rejected') throw result.reason;
  verifyRenderService(preflight[0].value);
  verifyVercelProject(preflight[1].value, config);
  const renderStatusQuery = new URLSearchParams({ limit: '1' });
  for (const status of RENDER_PENDING) renderStatusQuery.append('status', status);
  const renderBusy = await request('render', `${renderPath}/deploys?${renderStatusQuery}`);
  requireCondition(Array.isArray(renderBusy) && renderBusy.length === 0,
    'Render already has an in-progress deployment. Inspect it before rerunning.');
  const vercelBusy = await request('vercel', `/v7/deployments?projectId=${config.projectId}&target=production&state=${[...VERCEL_PENDING].join(',')}&limit=1`);
  requireCondition(Array.isArray(vercelBusy?.deployments) && vercelBusy.deployments.length === 0,
    'Vercel already has an in-progress production deployment. Inspect it before rerunning.');
  log(`Production targets verified for ${config.sha}.`);

  // Official API: https://api-docs.render.com/reference/create-deploy
  const render = await request('render', `${renderPath}/deploys`, { method: 'POST',
    body: { commitId: config.sha, clearCache: 'do_not_clear' } });
  requireCondition(/^dep-[a-zA-Z0-9]+$/u.test(render?.id || ''),
    'Render did not return a valid deployment ID. Outcome may be unknown; inspect before rerunning.');
  const renderId = render.id;
  log(`Render deployment accepted: ${renderId}.`);
  await poll('Render deployment', deployTimeoutMs, async () => {
    const deployment = await request('render', `${renderPath}/deploys/${renderId}`);
    requireCondition(deployment?.id === renderId, 'Render deployment identity mismatch.');
    if (deployment.commit?.id) requireCondition(deployment.commit.id === config.sha, 'Render deployment source commit mismatch.');
    requireCondition(!RENDER_FAILED.has(deployment.status), 'Render deployment failed or was canceled; frontend deployment stopped.');
    requireCondition(RENDER_PENDING.has(deployment.status) || deployment.status === 'live', 'Unknown Render deployment status.');
    if (deployment.status === 'live') {
      requireCondition(deployment.commit?.id === config.sha, 'Live Render deployment has no matching commit.');
      return { done: true };
    }
    return { state: deployment.status };
  });
  await poll('Backend health verification', verifyTimeoutMs, async () => ({
    done: verifyHealth(await request('backend', '/api/health'), source), state: 'waiting for the checked backend versions',
  }));
  log('Render is live and the production backend health check passed.');

  // Official API: https://vercel.com/docs/rest-api/deployments/create-a-new-deployment
  const vercel = await request('vercel', '/v13/deployments', { method: 'POST', body: {
    name: TARGET.vercelName, project: config.projectId, target: 'production',
    gitSource: { type: 'github', repoId: TARGET.repositoryId, ref: TARGET.branch, sha: config.sha },
  } });
  requireCondition(/^[a-zA-Z0-9_]+$/u.test(vercel?.id || ''),
    'Vercel did not return a valid deployment ID. Outcome may be unknown; inspect before rerunning.');
  const vercelId = vercel.id;
  log(`Vercel deployment accepted: ${vercelId}.`);
  await poll('Vercel deployment', deployTimeoutMs, async () => {
    const deployment = await request('vercel', `/v13/deployments/${vercelId}?withGitRepoInfo=true`);
    verifyVercelDeployment(deployment, config, vercelId);
    requireCondition(!VERCEL_FAILED.has(deployment.readyState), 'Vercel deployment failed or was canceled.');
    requireCondition(!deployment.aliasError, 'Vercel production alias assignment failed.');
    requireCondition(VERCEL_PENDING.has(deployment.readyState) || deployment.readyState === 'READY', 'Unknown Vercel deployment status.');
    return { done: deployment.readyState === 'READY' && deployment.aliasAssigned === true,
      state: deployment.readyState === 'READY' ? 'waiting for the production alias' : deployment.readyState };
  });
  await poll('Frontend version verification', verifyTimeoutMs, async () => {
    const manifest = await request('frontend', `/deployment.json?release=${config.sha}`);
    const matches = manifest?.schemaVersion === 1 && manifest.source?.commit === config.sha
      && manifest.source.provider === 'vercel' && manifest.source.dirty === null;
    return { done: matches, state: 'waiting for the checked production commit' };
  });
  const frontendHealth = await request('frontend', '/api/health');
  requireCondition(verifyHealth(frontendHealth, source), 'Production frontend proxy health or backend version mismatch.');
  const auth = await request('frontend', '/api/auth');
  requireCondition(auth?.mode === 'signed_out' && auth.user === null && auth.session === null,
    'Production signed-out authentication check failed.');
  log(`Production release verified: ${config.sha}. No speech calls or database rollback were performed.`);
  return { sha: config.sha, renderDeploymentId: renderId, vercelDeploymentId: vercelId,
    frontendOrigin: TARGET.frontendOrigin, backendOrigin: TARGET.backendOrigin };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireCondition(process.argv.length === 2, 'release-production accepts no command-line arguments.');
    await releaseProduction();
  } catch (error) {
    console.error(error instanceof ReleaseError ? error.message : 'Production release failed unexpectedly. No automatic rollback was attempted.');
    process.exitCode = 1;
  }
}
