# Kilele Retail OS — Render startup bootstrap

Render's free web-service plan does not provide a pre-deploy command. In production, the compiled server now performs a guarded one-time bootstrap during startup when the configured database has no users.

Set these variables temporarily in Render:

```text
NODE_ENV=production
PREVIEW_MODE=false
PORT=3001
DATABASE_PATH=/app/data/production.sqlite
APP_ORIGIN=https://your-service.onrender.com
BUSINESS_NAME=Your business name
BOOTSTRAP_NAME=Business owner
BOOTSTRAP_EMAIL=owner@example.com
BOOTSTRAP_PASSWORD=your-private-password-at-least-12-characters
```

After a successful deployment log says `Workspace bootstrapped for ...`, remove `BOOTSTRAP_NAME`, `BOOTSTRAP_EMAIL`, and `BOOTSTRAP_PASSWORD`, then redeploy. Keep `DATABASE_PATH` on a persistent disk mounted at `/app/data`. Leave the Docker Command as:

```text
node dist/server/index.js
```

The bootstrap is transactional and the normal server starts only after the owner workspace exists. Never use this with the preview database or leave bootstrap credentials configured permanently.

## PostgreSQL mode (Supabase)

With `DATABASE_ENGINE=postgres` the ledger lives in Supabase and `DATABASE_PATH` is ignored: no
SQLite file is opened, created or read. The bootstrap rule is unchanged — one-time owner creation
from the environment, transactional, and the server only listens afterwards — but migrations must run
as a separate **release** step, because the production default is `DATABASE_AUTO_MIGRATE=false`.

| Render field        | Value                                                          |
| ------------------- | -------------------------------------------------------------- |
| Build Command       | `npm ci && npm run build`                                      |
| **Release Command** | `npm run release:pg` (migrate, then verify the guard triggers) |
| Docker Command      | `node dist/server/index.js`                                    |

```text
NODE_ENV=production
PREVIEW_MODE=false
PORT=3001
DATABASE_ENGINE=postgres
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE
DATABASE_SSL=require
DATABASE_AUTO_MIGRATE=false
APP_ORIGIN=https://your-service.onrender.com
BUSINESS_NAME=Your business name
BOOTSTRAP_NAME=Business owner
BOOTSTRAP_EMAIL=owner@example.com
BOOTSTRAP_PASSWORD=your-private-password-at-least-12-characters
```

`DATABASE_URL` is a **server-only** secret. It must never be prefixed `VITE_`, never appear in the
client bundle, and never be pasted into a browser-facing variable. Remove the three `BOOTSTRAP_*`
values after the log shows `Workspace bootstrapped for ...` and redeploy, exactly as in SQLite mode.

The deploy order is `build → release (migrate + verify protections) → start`. If the release command
is missing, the API does not serve a partial schema: it exits before listening with
`The database is missing N migration(s): ...`, and it also refuses to listen when any of the 65
financial guard triggers is absent. `npm run release:protections` exits non-zero in that case, so the
deploy fails instead of shipping a ledger without its immutability rules.

**Do not point a live till at PostgreSQL mode yet.** Only `GET /api/health`, `GET /api/engine`,
`GET /api/auth/me` and the sign-in, sign-out, preview and password routes are converted; every
business route answers `503 NOT_MIGRATED`, even with a valid session, until its slice is migrated.
Progress and the remaining order are in [docs/POSTGRES_MIGRATION.md](POSTGRES_MIGRATION.md).
