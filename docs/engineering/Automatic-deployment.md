# Automatic deployment

Requested on 2026-10-18: updates to the collaboration repository's `main` should automatically run checks, synchronize the deployment fork, and release the same commit to Render and Vercel. There is no manual approval step for each release. Credential setup and the first live workflow run must be verified before this is described as enabled.

## Release path

1. A push or merge to `OrchidRLan/Spec_AI-Powered-Shanghainese-Learning-Through-Virtual-Urban-Exploration/main` starts **Check and sync to deployment fork**. Pull requests run checks only.
2. The checks install locked dependencies, test the application, content, audio, proxy, database maintenance and release automation, and build the pending-acceptance site. They receive no deployment credentials and make no live speech calls.
3. After checks pass, the sync job verifies the source and fork identities, fork network, current commit and ancestry. It advances `hollis-yang/Spec-Virtual-Shanghainese-Learning/main` to the exact checked SHA using `force:false`. An independent fork commit is never overwritten or merged automatically.
4. After re-reading both branches, it sends the fork a `release-checked-commit` event containing the SHA. This is the only automatic release trigger; a direct push to the fork does not independently publish the site.
5. **Deploy production** verifies that SHA is still current `main` in both repositories, runs checks on that exact commit, then rechecks freshness before accessing deployment credentials.
6. The release script verifies the existing platform targets and checks for another in-progress deployment. It deploys the exact SHA to Render, waits for Live and matching backend health, then deploys the exact SHA to Vercel. It waits for Ready, production-domain assignment, matching `/deployment.json`, proxy health and signed-out authentication.

Render and Vercel's independent Git auto-deploy switches stay off. The GitHub workflow controls deployment order. The existing Render pre-start backup runs before the application starts; releases retain the persistent database and do not restore snapshots automatically.

The source of truth remains the collaboration repository. The local `npm run git:publish` command can still publish and immediately synchronize reviewed agent work. The automatic workflow also handles an already synchronized fork and requests the release after its checks. Ordinary collaborator pushes to the collaboration `main` no longer depend on that local command.

## Credentials and configuration

| Location | Name | Purpose and scope |
| --- | --- | --- |
| Collaboration repository Actions secret | `FORK_SYNC_TOKEN` | Fine-grained GitHub token, limited to the deployment fork; Contents and Workflows read/write, plus required Metadata read. Contents also permits the repository dispatch. No account-wide repository access or Administration permission. |
| Fork `production` environment secret | `RENDER_API_KEY` | Render account API access, used by the script only for the existing service and its deployments. The platform token itself is account scoped. |
| Fork `production` environment secret | `VERCEL_TOKEN` | Vercel token scoped to the `spec-virtual-shanghainese-learning` project within `hollis-yang's projects`; used for that existing project's deployments. |
| Fork Actions variable | `VERCEL_PROJECT_ID` | Actual `prj_…` identifier for `spec-virtual-shanghainese-learning`. |
| Fork Actions variable | `VERCEL_TEAM_ID` | Actual `team_…` identifier for the project's workspace. |

The GitHub and Vercel tokens created on 2026-10-18 expire on **2027-01-16** (90 days). Rotate their GitHub secret values before expiry. Render API keys have no selected expiry in the creation UI and remain valid until revoked. Do not place any token in repository files, logs, client environment variables or screenshots. Production speech and proxy secrets remain in their current hosting-platform configuration and are not copied into CI.

Enable Actions in the deployment fork if GitHub disables inherited workflows. The `production` environment should permit the `main` branch and have no required reviewers or wait timer, so authorized main releases can run automatically. Keep the repository's default workflow permissions read-only; these workflows do not need to broaden that default.

All third-party Actions are pinned to full commit SHAs. The source workflow has no deployment credentials. The fork's validation jobs do not inherit the `production` environment's secrets. Collaborators who can modify trusted main workflows can affect their behavior; protect and review workflow changes as part of normal collaboration.

## Status, failure, and retry

- Source checks and synchronization: [collaboration Actions](https://github.com/OrchidRLan/Spec_AI-Powered-Shanghainese-Learning-Through-Virtual-Urban-Exploration/actions).
- Deployment progress: [fork Actions](https://github.com/hollis-yang/Spec-Virtual-Shanghainese-Learning/actions/workflows/deploy-production.yml).
- Production: [A little Shanghai](https://spec-virtual-shanghainese-learning.vercel.app).

Releases are serialized and an in-progress release is not canceled by a newer commit. A queued version that is no longer current main is skipped; newer checked main is released instead. GitHub may replace an older pending run with a newer one. This is event driven, not scheduled polling, and GitHub's job queue still affects the start time.

Check failure prevents synchronization and deployment. Backend failure stops the frontend step. If the frontend fails after the backend succeeds, the backend may already be updated; the run is failed and the versions must be inspected. There is no atomic update across two providers and no automatic database rollback. Keep API changes compatible during the transition. Render's attached disk means backend updates can briefly interrupt requests.

Deployment POST requests are sent once, without automatic retries: a network timeout may leave an accepted deployment running. Inspect the platform before rerunning. Polling GET requests can retry temporary failures within a bounded deadline. A prior in-progress deployment blocks a new release.

For a deliberate retry, rerun the failed source workflow or run **Deploy production** in the fork on `main`; its optional SHA must match current main in both repositories. Retrying an already successful SHA can redeploy both services. Rollbacks to older versions are deliberate platform operations described in [Deployment](Deployment.md), not this freshness-checked forward-release workflow.

## Verification

Local automation tests use simulated GitHub, Render and Vercel responses and no credentials. `npm run test:automation` covers exact commits, ancestry, stale jobs, mismatched identities, deployment order, failures, timeouts and redacted errors. A workflow linter checks YAML syntax and expressions. These do not establish that credentials are installed or a real deployment succeeded; actual execution evidence belongs in [Development status](../Development-status.md).

Deployment checks do not call ASR/TTS, use the microphone, or grant teaching approval. Batch E's voice, device and content evaluation remains separate.
