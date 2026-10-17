# A little Shanghai

Practise everyday Shanghainese through four virtual stops around Yu Garden: Nanxiang Steamed Bun Restaurant, Shanghai Old Restaurant, the Pear Candy Shop, and Huxinting Teahouse.

- Guided conversations with speech recognition, visible results, and learner-controlled progression.
- Chinese and English interfaces, aligned romanization, and normal/slow teaching audio.
- Account-based progress, temporary guest access, and review for completed stops.

Built with React, TypeScript, Vite, FastAPI, and SQLite. The four-stop implementation is available locally; language materials and audio remain review drafts. Deployment and final acceptance are pending.

## Local setup

Requires Node.js 22.12+ and Python 3.11. From the repository root on macOS or Linux:

```sh
npm ci
python3.11 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.lock
[ -f .env ] || cp .env.example .env
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). This starts the frontend and the API at `127.0.0.1:8000`. Stop the existing instance with Ctrl+C before starting another; restart after backend or configuration changes.

The example configuration disables live speech services. Configure credentials and enable the required service explicitly in `.env`; keep keys on the server, never in `VITE_*` variables or frontend code. See the [API and configuration guide](backend/API.md).

SQLite data is stored in `backend/data/`. Accounts retain saved progress; guest access is temporary and tied to the current browser tab. Local data and credentials are excluded from Git.

## Checks and builds

```sh
npm run check
npm run build
```

`check` runs type, content, UI, API, and audio checks. `build` creates the current draft frontend bundle. Automated checks do not replace language review or live speech evaluation.

`npm run build:deployment` builds the version awaiting acceptance, checks teaching files and audio integrity, and writes a public version manifest. It preserves all review-draft labels. `npm run build:release` still requires approved teaching content and audio and is currently blocked by pending review.

Deployment uses Vercel for the frontend/API proxy and Render for the Python API with persistent SQLite. See the [deployment guide](docs/engineering/Deployment.md) for platform settings, secrets, checks, and updates; see [database maintenance](docs/engineering/Database-maintenance.md) for backups and recovery. Never deploy the local database or `.env`.

## Documentation

- [Documentation index](docs/README.md)
- [Current product specification](docs/Product-spec.md)
- [Development status](docs/Development-status.md)
- [Batch D and E plan](docs/Batch-DE-plan.md): deployment preparation and deployment first, then real speech, device compatibility, model evaluation, and final acceptance.
