# Safely repair the Cloudflare Pages deployment

## Current diagnosis

The GitHub-to-Cloudflare integration uploaded commit `44bdf49` successfully, but the public site served the source `index.html` pointing at `/src/main.tsx`. That TypeScript module was delivered as `application/octet-stream`. `/api/health` and `/api/auth/me` also returned the HTML fallback, not a business API. A green deployment check therefore did **not** establish a working application.

The repository still has the audited **Express + SQLite** backend. No Supabase database migration, RLS policies or application integration is present. Creating/linking a Supabase project does not automatically replace SQLite, install Kilele’s tables or implement its API. Do not paste `server/schema.sql` into Supabase or expose service-role keys in browser variables.

## 1. Fix the Pages build — no custom domain required

Open **Workers & Pages → kilele-retail-os → Settings → Builds & deployments / Build configuration** and change only the build fields:

| Setting                | Value                                               |
| ---------------------- | --------------------------------------------------- |
| Framework              | React (Vite), or None with the command below        |
| Build command          | `npm run build:pages`                               |
| Build output directory | `dist/client`                                       |
| Root directory         | Repository root (leave blank)                       |
| Node version           | `22` (the repository also includes `.node-version`) |

Save and retry the latest production deployment. Do not publish `.`/the repository root, `src`, `public`, or `dist/server`. The guard in `build:pages` checks that the emitted HTML references built JavaScript and rejects database, secret, server/source or test files in the output.

Your canonical test address can remain **https://kilele-retail-os.pages.dev**. You do not need to purchase a domain.

Cloudflare documents both the build command and output directory as project build settings [2](https://developers.cloudflare.com/pages/configuration/build-configuration/). I have **not** blindly added a production Wrangler configuration: Cloudflare says a Wrangler file becomes the source of truth and recommends downloading/reviewing an existing project's configuration first [2](https://developers.cloudflare.com/pages/functions/wrangler-configuration/). Your existing Supabase bindings/secrets have not been removed or overwritten.

## 2. Connect the existing API — separate from the frontend build

The new `functions/api/[[path]].ts` Pages adapter forwards `/api/*` to an explicitly configured **Kilele API server**. It does not implement another auth system, ledger, database or fake sign-in.

If an actual Kilele backend is already deployed:

1. Add a **server-side Pages variable** named `KILELE_API_ORIGIN` in the appropriate environment, set to that backend's exact public HTTPS origin. Use an origin only: no path, credentials or trailing slash.
2. On the backend, set `APP_ORIGIN=https://kilele-retail-os.pages.dev`, `NODE_ENV=production`, and `PREVIEW_MODE=false`. Use a clean operational database on persistent storage and configure real private owner credentials as documented in `DEPLOYMENT.md`.
3. Verify proxy trust/client IP for the actual hosting topology. The adapter does not rewrite the browser's Origin or bypass CSRF/RBAC.
4. Redeploy and use the canonical `pages.dev` address. Hashed preview URLs have a different browser origin: **do not point public branch previews at live books**. Give preview environments their own isolated API/database, or leave them unconfigured.

`KILELE_API_ORIGIN` is **not** a Supabase project URL. The existing server expects its own `/api/auth/me`, `/api/sales`, inventory, approval and reporting routes. Standard static Pages hosting does not run the native `better-sqlite3` Node server automatically.

The adapter:

- returns an explicit, non-cacheable JSON **503** if no backend is configured;
- accepts only an explicit HTTPS upstream and refuses credentials, paths, loopback/private literals and self-proxy loops;
- forwards cookies, CSRF, original Origin and idempotency keys without injecting privileged database credentials;
- makes **one** upstream attempt, with a timeout and request-size limit;
- rejects redirects and HTML-as-API fallbacks; failed financial confirmations remain **outcome unknown**, not “nothing was posted”;
- streams legitimate PDF/CSV/image responses and preserves upstream permission denials.

If there is no API host yet, that is still a required deployment step. A provider-issued HTTPS hostname is sufficient; a custom domain is not required. The current Docker/Node deployment is documented separately. No paid host or new database has been provisioned by this repair.

## 3. Supabase remains a separately planned task

Before changing the database engine, supply the **non-secret Supabase project URL** and establish authorised administrative access through a secure channel. Do not send passwords or service-role keys in chat, publish them to GitHub or put them in `VITE_*` variables.

A safe migration would need PostgreSQL-compatible schema/constraints, transactional stock/financial functions, tenant/RBAC enforcement, immutable audit/reversal rules, authentication mapping, data-preservation/rollback checks and the existing accounting regression suite. That work must happen against an isolated staging project first. This repair does **not** claim Supabase is connected or migrate/delete any existing records.

## 4. Verify before entering business data

```bash
npm ci
npm run build:pages
npm run check:deployment -- https://kilele-retail-os.pages.dev
```

Expected public checks:

- `/` references `/assets/*.js`, not `/src/main.tsx`.
- `/api/health` returns JSON with `status: "ok"`.
- `/api/auth/me` returns Kilele's session JSON, not HTML. A correctly configured unauthenticated session can have `user: null`.

The site now shows a clear connection/setup screen if the API is unavailable, rather than pretending the login/database works. A source-only deployment also has a static fallback message instead of a blank page. Those messages are diagnostics, **not operational acceptance**.

After these checks, use an authorised isolated test account to verify sign-in and the complete sale → stock → journal → receipt → report → audit chain. Existing fiscal, payment-provider, hardware and production go-live requirements still apply.

## What requires account access

The repository patch can be pushed after GitHub authorization. Cloudflare build settings and the backend variable require access to your Cloudflare project. I cannot safely claim those account settings were changed without access or public verification. Existing bindings should be preserved; change only the specific build fields/variable above.
