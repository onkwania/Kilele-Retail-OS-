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
