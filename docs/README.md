# Documentation

Start with the current documents below. Historical proposals, revisions, and verification records are preserved in the archive; they do not override the current specification or the D/E plan.

## Current documents

| Document | Purpose |
| --- | --- |
| [Product specification](Product-spec.md) | Current four-stop experience, guided practice, accounts, review, and audio behavior |
| [Development status](Development-status.md) | Delivered work, verification evidence, open items, and next steps |
| [Batch D/E plan](Batch-DE-plan.md) | D: deployment preparation and deployment; E: validation, evaluation, and fixes |

For local setup and commands, use the [project README](../README.md). Implementation work also follows [AGENTS.md](../AGENTS.md).

## Engineering, content, and design

| Reference | Purpose |
| --- | --- |
| [Deployment](engineering/Deployment.md) | Vercel/Render setup, environment variables, pending-acceptance builds, and rollout checks |
| [Automatic deployment](engineering/Automatic-deployment.md) | Main-branch checks, fork synchronization, sequential releases, credentials, and failure recovery |
| [Database maintenance](engineering/Database-maintenance.md) | Consistent SQLite backups, safe recovery, and guest cleanup |
| [Backend API](../backend/API.md) | Authentication, guest sessions, progress, speech interfaces, and maintenance commands |
| [Speech integration](engineering/Speech-integration.md) | Provider contracts, audio production, actual call history, and verification limits |
| [Content review](content-review/README.md) | Current teaching materials, review evidence, and approval workflow |
| [Brand assets](design/brand/README.md) | Logo sources and current web assets |
| [B+C scene design](design/Batch-BC-design.md) | Restaurant, candy shop, and teahouse scene implementation |
| [Original design baseline](design/Batch-A-design.md) | Earlier visual system and scene evidence; later UI behavior is in the current specification |
| [Screenshots](design/previews/) | Screenshots grouped by milestone, linked from the corresponding verification records |

## Historical records

[Archive index](archive/README.md) groups the original proposals, batch plans, revisions, and verification records. Screenshots, teaching material versions, audio manifests, and original brand assets remain in their existing locations.

Eight short files remain at their original paths because frozen teaching-content packages reference them. They only link to the archived originals and the current specification; do not expand them into a second set of requirements.

## Maintenance

- Update product behavior in `Product-spec.md`, actual progress in `Development-status.md`, and remaining D/E work in `Batch-DE-plan.md`.
- Keep earlier decisions and test results in the archive. Distinguish historical results from current verification and completed work from planned work.
- Preserve content and audio hashes when reorganizing documentation. Update links and check both file paths and heading anchors.
