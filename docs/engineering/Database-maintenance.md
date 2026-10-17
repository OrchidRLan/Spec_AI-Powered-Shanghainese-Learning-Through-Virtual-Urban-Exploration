# Database maintenance

Batch D uses one Render backend instance with a persistent disk mounted at `/var/data` and `DATABASE_PATH=/var/data/app.db`. The first deployment starts with an empty database; do not upload the development database. Accounts and progress created online remain on this disk across application deployments.

Run maintenance from the **same running backend instance**, using its Render Shell or SSH connection. A separate cron service, one-off job, build, or pre-deploy command cannot access this disk. See [Render persistent disk constraints](https://render.com/docs/disks#disk-limitations-and-considerations) and [Render Shell access](https://render.com/docs/ssh). Do not run these commands against a local user's database as part of automated tests.

## Consistent backup

From the repository root on the backend instance, create a private directory once, then select a new, dated filename for each backup:

```sh
install -d -m 700 /var/data/backups
python scripts/database-maintenance.py backup --database /var/data/app.db --output /var/data/backups/app-20261017-120000.db
```

The script uses SQLite's online backup API, including committed WAL transactions. It does not copy a live `.db` file directly. Before publishing the backup, it runs full SQLite integrity and foreign-key checks. Output files have mode `0600`; an existing destination is never replaced. Successful output includes a SHA-256 checksum. No application modules, `.env`, speech providers, migrations, or user-facing routes are loaded.

The [Render startup script](../../scripts/start-render.py) checks production settings and the port before touching the data directory. If a database exists, it creates a verified `auto-prestart-<UTC timestamp>.db` snapshot before importing the application or running its schema initialization/migration. Only after a successful backup does it retain the three most recent automatic snapshots; manual files and symlinks are not deleted. Backup failure stops startup before migration or backup rotation. With no database present, the application initializes an empty one on its first start. This startup backup is local to the persistent disk. The production API lifespan separately manages the same-instance daily schedule described below; neither creates an off-disk copy.

Production starts one maintenance worker after the application database has initialized. It runs once on startup and checks again every 15 minutes. On the first cycle of each UTC date, it invokes the same verified backup script and publishes an `auto-daily-<UTC timestamp>.db` snapshot. A same-day completed snapshot prevents duplicate daily backups after a restart. Only after a successful backup does it retain the latest seven daily snapshots; the three pre-start snapshots and manual files are separate and untouched. It checks available disk headroom before staging a snapshot; failures preserve existing copies and retry on the next cycle. The worker is enabled only in production and assumes the single API worker enforced by the Render launcher.

Maintenance logs only fixed success/failure event names and a removed-guest count. Script output is suppressed. On normal application shutdown, the worker is stopped and joined; an in-flight backup child is terminated and reaped before its private staging directory is removed. No maintenance thread or backup subprocess is intentionally left running after shutdown. A platform hard kill can still interrupt the process; successful published snapshots remain standalone and partial staging files are not restore points.

A backup on the same disk is only a first copy: transfer verified snapshots through the service's authenticated SSH/SFTP connection to an approved private off-disk location. Record the checksum, UTC time, application commit, and database path separately. Never put backups in Git, the frontend's public directory, a public download URL, or task attachments. They contain password hashes, account tokens' hashes, transcripts, and learning progress.

For the initial small test, retain seven daily off-disk snapshots plus the latest pre-update snapshot, and review disk space before each backup. Old snapshots must be removed from both locations according to that retention rule; deleting an expired guest from the live database does not erase earlier backups. Storage credentials and automated off-disk transfer are configured separately when the destination is selected. No remote backup schedule is implied by this script.

## Offline verification and recovery

Inspect a downloaded standalone backup, without starting the application:

```sh
python scripts/database-maintenance.py check --database /private/path/app-20261017-120000.db
```

The check is read-only and checks both database integrity and foreign keys. It does not prove that a particular application version understands the schema; record and use the matching application commit during recovery.

Recovery requires a maintenance window:

1. Stop application requests and **all database writers**, including the guest-cleanup process. Keep the disk available to an administrative shell on the same service instance. Use the deployment's maintenance procedure; merely closing a browser, stopping one worker, or opening a Shell does not stop the backend. If writers cannot be stopped while the disk remains accessible, stop and resolve that operational step first.
2. Preserve the current database and its SQLite sidecar files. If readable, take a separate verified snapshot of it. Keep the chosen recovery backup and its recorded checksum unchanged.
3. Check the chosen backup, then restore to a **new filename** on the mounted disk:

   ```sh
   python scripts/database-maintenance.py check --database /var/data/backups/app-20261017-120000.db
   python scripts/database-maintenance.py restore --backup /var/data/backups/app-20261017-120000.db --output /var/data/app-restored-20261017.db --service-stopped
   ```

4. Set the service's `DATABASE_PATH` to that new file, select the compatible application commit, and restart the backend. The `--service-stopped` flag is an operator confirmation; the script cannot stop or detect remote writers. It deliberately offers no overwrite option and leaves the previous database unchanged.
5. Check health, login, saved progress, account separation, and a write followed by a restart. Reopen access only after these checks succeed. Log the recovery point and any progress lost since that backup. Keep the previous database until the recovery has been accepted.

Application rollback and database rollback are different operations. Prefer rolling back code alone if its schema is still compatible. Do not restore an older database merely to roll back frontend code. Do not use a whole-disk snapshot as the application's database backup procedure; Render also recommends database-specific backups for [custom database recovery](https://render.com/docs/disks#restoring-a-custom-database).

## Expired guests

Reuse the existing cleanup implementation; it deletes expired guest-owned sessions, retains account/legacy sessions, and clears expired auth tokens and old rate-limit entries:

```sh
PYTHONPATH=backend python -m app.cleanup_guests --database /var/data/app.db
```

Run only against the existing, intended database: the existing command initializes missing database paths, so first verify the path and mounted disk. It does not load `.env` or speech providers. Application API requests already invoke the same cleanup function; `/api/health` is read-only and explicitly excluded, so Render health checks do not clean up guest data. The production maintenance worker now invokes the same cleanup function once after startup and every 15 minutes **inside the same backend instance**, using an independent SQLite transaction. It opens an existing database without creating a replacement file if the database disappears. It deletes only expired guest data and stale authentication entries; account, linked-account and legacy records retain the existing cleanup protections. Failure is logged without private data and retried on a later cycle. Development mode does not start this worker. Health requests remain read-only and do not trigger cleanup. Do not configure a separate Render cron service for this database. Confirm actual scheduled execution and persistence on the deployed instance; the interval is an operational target while the service is running, not a promise of deletion at the exact expiry time.

The existing 24-hour guest credential expiry is unchanged. Guests lose access at expiry; physical removal occurs on a subsequent API request or scheduled cleanup. Backup retention remains a separate concern.

## Local script verification

```sh
backend/.venv/bin/python -m unittest discover -s scripts -p 'test_*.py' -v
backend/.venv/bin/python -m pytest backend/tests/test_maintenance.py -q
```

Tests create temporary databases only. They cover committed WAL data, incomplete transactions, restrictive file permissions, integrity and foreign-key failures, missing sources, existing destinations, publication races, timeout cleanup, and a restore that retains the previous database. Launcher checks cover empty first start, backup before migration, automatic-only retention, configuration validation before file changes, and aborting on backup failure without deleting old backups or starting the API. Production-maintenance tests additionally cover idle guest cleanup with account/active/legacy preservation, verified daily snapshots and seven-copy retention, once-per-UTC-day behavior, failed-backup retention and sanitized logs, missing-database refusal, subprocess timeout/shutdown reaping, and production-only lifespan management.
