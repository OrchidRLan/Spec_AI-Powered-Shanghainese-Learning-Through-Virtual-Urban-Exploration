import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseProduction, releaseConfiguration, TARGET } from './release-production.mjs';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const PROJECT = 'prj_testProject';
const ENV = {
  RELEASE_SHA: SHA, RENDER_API_KEY: 'private-render-key', VERCEL_TOKEN: 'private-vercel-token',
  RENDER_SERVICE_ID: TARGET.renderServiceId, VERCEL_PROJECT_ID: PROJECT, VERCEL_TEAM_ID: 'team_testTeam',
  GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: TARGET.repository, GITHUB_REPOSITORY_ID: TARGET.repositoryId,
  GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'repository_dispatch',
};
const SOURCE = { head: SHA, automaticGitDeployment: false,
  contentVersion: 'batch-a-r3.2026-10-17.v1', ruleVersion: 'nanxiang-rules.v3' };
const HEALTH = { status: 'ok', mode: 'production', content_version: SOURCE.contentVersion, rule_version: SOURCE.ruleVersion };
const renderPath = `/v1/services/${TARGET.renderServiceId}`;
const RENDER_DEPLOY = 'dep-testDeployment';
const VERCEL_DEPLOY = 'dpl_testDeployment';
const response = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});

function harness({ modify = () => undefined, env = {}, source = {}, renderStates = ['live'], vercelStates = ['READY'] } = {}) {
  const calls = [], logs = [];
  let clock = 0, renderPolls = 0, vercelPolls = 0;
  const options = {
    env: { ...ENV, ...env }, readSource: () => ({ ...SOURCE, ...source }),
    now: () => clock, sleep: async ms => { clock += ms; }, log: message => logs.push(message),
    pollIntervalMs: 10, deployTimeoutMs: 50, verifyTimeoutMs: 30, requestTimeoutMs: 100,
    fetchImpl: async (input, init) => {
      const url = new URL(input), method = init.method;
      const call = { url, method, headers: init.headers, body: init.body && JSON.parse(init.body), init };
      calls.push(call);
      let value;
      if (url.origin === 'https://api.render.com') {
        assert.equal(init.headers.Authorization, `Bearer ${ENV.RENDER_API_KEY}`);
        if (url.pathname === renderPath) value = {
          id: TARGET.renderServiceId, name: TARGET.renderName, type: 'web_service', branch: 'main',
          repo: `https://github.com/${TARGET.repository}`, serviceDetails: { url: TARGET.backendOrigin },
          autoDeploy: 'no', autoDeployTrigger: 'off', suspended: 'not_suspended',
        };
        else if (url.pathname === `${renderPath}/deploys` && method === 'GET') {
          assert.deepEqual(url.searchParams.getAll('status'),
            ['created', 'queued', 'build_in_progress', 'pre_deploy_in_progress', 'update_in_progress']);
          assert.equal(url.searchParams.get('limit'), '1');
          value = [];
        }
        else if (url.pathname === `${renderPath}/deploys` && method === 'POST') value = { id: RENDER_DEPLOY };
        else if (url.pathname === `${renderPath}/deploys/${RENDER_DEPLOY}`) value = {
          id: RENDER_DEPLOY, commit: { id: SHA }, status: renderStates[Math.min(renderPolls++, renderStates.length - 1)],
        };
      } else if (url.origin === 'https://api.vercel.com') {
        assert.equal(init.headers.Authorization, `Bearer ${ENV.VERCEL_TOKEN}`);
        assert.equal(url.searchParams.get('teamId'), options.env.VERCEL_TEAM_ID || null);
        if (url.pathname === `/v9/projects/${PROJECT}`) value = {
          id: PROJECT, name: TARGET.vercelName, accountId: 'team_testTeam',
          link: { type: 'github', repoId: 1423608435, org: 'hollis-yang',
            repo: 'Spec-Virtual-Shanghainese-Learning', productionBranch: 'main' },
        };
        else if (url.pathname === '/v7/deployments') value = { deployments: [] };
        else if (url.pathname === '/v13/deployments' && method === 'POST') value = { id: VERCEL_DEPLOY };
        else if (url.pathname === `/v13/deployments/${VERCEL_DEPLOY}`) {
          assert.equal(url.searchParams.get('withGitRepoInfo'), 'true');
          value = {
            id: VERCEL_DEPLOY, projectId: PROJECT, target: 'production',
            gitSource: { type: 'github', repoId: 1423608435, ref: 'main', sha: SHA }, aliasAssigned: true,
            readyState: vercelStates[Math.min(vercelPolls++, vercelStates.length - 1)],
          };
        }
      } else {
        assert.ok([TARGET.backendOrigin, TARGET.frontendOrigin].includes(url.origin));
        assert.equal(init.headers.Authorization, undefined, 'Public checks must never receive platform credentials.');
        assert.equal(method, 'GET', 'Online verification must not create users, mutate progress or invoke speech.');
        if (url.pathname === '/api/health') value = structuredClone(HEALTH);
        else if (url.pathname === '/api/auth') value = { mode: 'signed_out', user: null, session: null };
        else if (url.pathname === '/deployment.json') value = {
          schemaVersion: 1, source: { commit: SHA, provider: 'vercel', dirty: null },
        };
      }
      assert.notEqual(value, undefined, `Unexpected endpoint ${method} ${url.pathname}`);
      assert.equal(init.redirect, 'error');
      const override = await modify(call, value, calls);
      return override instanceof Response ? override : response(value);
    },
  };
  return { options, calls, logs, run: () => releaseProduction(options), posts: () => calls.filter(call => call.method === 'POST') };
}

test('deploys the same exact SHA to Render, waits for health, then Vercel and stable production checks', async () => {
  const h = harness({ renderStates: ['build_in_progress', 'update_in_progress', 'live'], vercelStates: ['QUEUED', 'BUILDING', 'READY'] });
  const result = await h.run();
  assert.deepEqual(h.posts().map(call => [call.url.origin, call.body]), [
    ['https://api.render.com', { commitId: SHA, clearCache: 'do_not_clear' }],
    ['https://api.vercel.com', { name: TARGET.vercelName, project: PROJECT, target: 'production',
      gitSource: { type: 'github', repoId: TARGET.repositoryId, ref: 'main', sha: SHA } }],
  ]);
  const backendHealthIndex = h.calls.findIndex(call => call.url.origin === TARGET.backendOrigin);
  const frontendPostIndex = h.calls.findIndex(call => call.url.origin === 'https://api.vercel.com' && call.method === 'POST');
  assert.ok(backendHealthIndex < frontendPostIndex);
  assert.equal(h.calls.at(-1).url.href, `${TARGET.frontendOrigin}/api/auth`);
  assert.equal(result.sha, SHA);
  assert.equal(result.renderDeploymentId, RENDER_DEPLOY);
  assert.equal(result.vercelDeploymentId, VERCEL_DEPLOY);
  for (const secret of [ENV.RENDER_API_KEY, ENV.VERCEL_TOKEN]) assert.ok(!h.logs.join('\n').includes(secret));
});

test('manual dispatch retry is supported without a team ID', async () => {
  const h = harness({ env: { GITHUB_EVENT_NAME: 'workflow_dispatch', VERCEL_TEAM_ID: '' } });
  await h.run();
  assert.equal(h.posts().length, 2);
});

for (const name of ['RELEASE_SHA', 'RENDER_API_KEY', 'VERCEL_TOKEN', 'RENDER_SERVICE_ID', 'VERCEL_PROJECT_ID']) {
  test(`missing ${name} fails before every network request`, async () => {
    const h = harness({ env: { [name]: '' } });
    await assert.rejects(h.run(), new RegExp(`Missing ${name}`, 'u'));
    assert.equal(h.calls.length, 0);
  });
}

test('rejects invalid SHA, wrong repository/event/ref/service and malformed credentials', () => {
  for (const change of [{ RELEASE_SHA: 'main' }, { RELEASE_SHA: SHA.toUpperCase() },
    { GITHUB_REPOSITORY: 'someone/another-repository' }, { GITHUB_REPOSITORY_ID: '123' },
    { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_ACTIONS: 'false' }, { RENDER_SERVICE_ID: 'srv_anotherService' },
    { VERCEL_PROJECT_ID: '../escape' }, { VERCEL_TEAM_ID: '../escape' }, { VERCEL_TOKEN: 'token\nvalue' }]) {
    assert.throws(() => releaseConfiguration({ ...ENV, ...change }));
  }
});

test('checkout mismatch or automatic Vercel Git deployment fails before network', async () => {
  for (const source of [{ head: OTHER_SHA }, { automaticGitDeployment: true }, { automaticGitDeployment: undefined }]) {
    const h = harness({ source });
    await assert.rejects(h.run(), /Checked-out commit|disable native automatic/u);
    assert.equal(h.calls.length, 0);
  }
});

test('both provider credentials and identities are checked before any mutation', async () => {
  for (const platform of ['render', 'vercel']) {
    const h = harness({ modify: call => call.url.hostname === `api.${platform}.com` ? response({ secret: ENV.VERCEL_TOKEN }, 401) : undefined });
    await assert.rejects(h.run(), /HTTP 401/u);
    assert.equal(h.posts().length, 0);
    assert.equal(h.calls.length, 2, 'Independent platform preflights should settle before returning.');
  }
});

for (const [label, mutation] of [
  ['Render repo', value => { value.repo = 'https://github.com/someone/wrong'; }],
  ['Render branch', value => { value.branch = 'other'; }],
  ['Render URL', value => { value.serviceDetails.url = 'https://wrong.example'; }],
  ['Render autoDeploy', value => { value.autoDeploy = 'yes'; }],
  ['Render autoDeployTrigger', value => { value.autoDeployTrigger = 'commit'; }],
  ['Render suspension', value => { value.suspended = 'suspended'; }],
  ['Vercel repo ID', value => { value.link.repoId = '123'; }],
  ['Vercel repo name', value => { value.link.repo = 'another'; }],
  ['Vercel branch', value => { value.link.productionBranch = 'other'; }],
  ['Vercel project', value => { value.id = 'prj_other'; }],
  ['Vercel team', value => { value.accountId = 'team_other'; }],
]) {
  test(`${label} preflight mismatch stops before deployments`, async () => {
    const h = harness({ modify: (call, value) => {
      if ((label.startsWith('Render') && call.url.pathname === renderPath)
        || (label.startsWith('Vercel') && call.url.pathname.startsWith('/v9/projects/'))) mutation(value);
    } });
    await assert.rejects(h.run());
    assert.equal(h.posts().length, 0);
  });
}

test('in-progress deployment from a prior run blocks a new release', async () => {
  for (const platform of ['render', 'vercel']) {
    const h = harness({ modify: (call, value) => {
      if (platform === 'render' && call.url.pathname === `${renderPath}/deploys`) value.push({ deploy: { id: 'dep_previous' } });
      if (platform === 'vercel' && call.url.pathname === '/v7/deployments') value.deployments.push({ uid: 'dpl_previous' });
    } });
    await assert.rejects(h.run(), /already has an in-progress/u);
    assert.equal(h.posts().length, 0);
  }
});

test('Render failed or canceled stops before frontend deployment', async () => {
  for (const state of ['build_failed', 'pre_deploy_failed', 'update_failed', 'canceled', 'deactivated']) {
    const h = harness({ renderStates: [state] });
    await assert.rejects(h.run(), /frontend deployment stopped/u);
    assert.equal(h.posts().length, 1);
  }
});

test('Render pending timeout stops before frontend deployment', async () => {
  const h = harness({ renderStates: ['build_in_progress'] });
  await assert.rejects(h.run(), /Render deployment timed out/u);
  assert.equal(h.posts().length, 1);
});

test('Render commit mismatch is fatal even when Live', async () => {
  const h = harness({ modify: (call, value) => {
    if (call.url.pathname.endsWith(RENDER_DEPLOY)) value.commit.id = OTHER_SHA;
  } });
  await assert.rejects(h.run(), /Render deployment source commit mismatch/u);
  assert.equal(h.posts().length, 1);
});

test('backend content/rule mismatch blocks frontend deployment', async () => {
  const h = harness({ modify: (call, value) => {
    if (call.url.origin === TARGET.backendOrigin) value.rule_version = 'unexpected';
  } });
  await assert.rejects(h.run(), /Backend health verification timed out/u);
  assert.equal(h.posts().length, 1);
});

test('POST transport and HTTP errors are not retried and never expose provider text', async () => {
  for (const platform of ['render', 'vercel']) for (const failTransport of [false, true]) {
    const h = harness({ modify: call => {
      if (call.method === 'POST' && call.url.hostname === `api.${platform}.com`) {
        if (failTransport) throw new Error(`Unexpected ${ENV.VERCEL_TOKEN} ${ENV.RENDER_API_KEY}`);
        return response({ message: ENV.VERCEL_TOKEN }, 503);
      }
    } });
    await assert.rejects(h.run(), error => {
      assert.ok(!error.message.includes(ENV.VERCEL_TOKEN));
      assert.ok(!error.message.includes(ENV.RENDER_API_KEY));
      return /HTTP 503|Outcome may be unknown/u.test(error.message);
    });
    assert.equal(h.posts().filter(call => call.url.hostname === `api.${platform}.com`).length, 1);
    assert.equal(h.posts().length, platform === 'render' ? 1 : 2);
  }
});

test('transient GET failure during polling is retried without another POST', async () => {
  let failures = 0;
  const h = harness({ modify: call => {
    if (call.url.pathname.endsWith(RENDER_DEPLOY) && failures++ === 0) return response({}, 503);
  } });
  await h.run();
  assert.equal(h.posts().length, 2);
  assert.equal(failures, 2);
});

test('malformed or oversized response stops without printing response content', async () => {
  for (const body of [ENV.VERCEL_TOKEN, 'a'.repeat(1024 * 1024 + 1)]) {
    const h = harness({ modify: call => call.url.pathname === renderPath ? new Response(body) : undefined });
    await assert.rejects(h.run(), /invalid JSON|size limit/u);
    assert.equal(h.posts().length, 0);
  }
});

test('Vercel failure, cancellation, blocking or timeout cannot report success', async () => {
  for (const state of ['ERROR', 'CANCELED', 'BLOCKED', 'BUILDING']) {
    const h = harness({ vercelStates: [state] });
    await assert.rejects(h.run(), /Vercel deployment failed|Vercel deployment timed out/u);
    assert.equal(h.posts().length, 2);
    assert.ok(!h.calls.some(call => call.url.pathname === '/deployment.json'));
  }
});

test('Vercel source SHA, repo, target, identity, or alias error prevents verification', async () => {
  for (const mutation of [value => { value.gitSource.sha = OTHER_SHA; }, value => { value.gitSource.repoId = '123'; },
    value => { value.target = 'preview'; }, value => { value.projectId = 'prj_another'; },
    value => { value.aliasError = { message: ENV.VERCEL_TOKEN }; }]) {
    const h = harness({ modify: (call, value) => {
      if (call.url.pathname.endsWith(VERCEL_DEPLOY)) mutation(value);
    } });
    await assert.rejects(h.run(), /mismatch|alias assignment failed/u);
    assert.equal(h.posts().length, 2);
  }
});

test('READY waits for production alias assignment', async () => {
  let polls = 0;
  const h = harness({ modify: (call, value) => {
    if (call.url.pathname.endsWith(VERCEL_DEPLOY)) value.aliasAssigned = ++polls > 1;
  } });
  await h.run();
  assert.equal(polls, 2);
});

test('stable domain manifest mismatch times out instead of claiming the deployment is verified', async () => {
  const h = harness({ modify: (call, value) => {
    if (call.url.pathname === '/deployment.json') value.source.commit = OTHER_SHA;
  } });
  await assert.rejects(h.run(), /Frontend version verification timed out/u);
  assert.ok(!h.calls.some(call => call.url.pathname === '/api/auth'));
});

test('stable frontend health and signed-out authentication are required', async () => {
  for (const path of ['/api/health', '/api/auth']) {
    const h = harness({ modify: (call, value) => {
      if (call.url.origin === TARGET.frontendOrigin && call.url.pathname === path) value.mode = 'unexpected';
    } });
    await assert.rejects(h.run(), /proxy health|authentication check failed/u);
    assert.equal(h.posts().length, 2);
  }
});
