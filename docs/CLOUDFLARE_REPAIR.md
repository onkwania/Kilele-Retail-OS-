# Cloudflare repair checkpoint — 5 September 2026

## Safely changed in the repository

- Preserved and fast-forwarded to the user's GitHub commit `44bdf49`, including the SLSA workflow. No force/reset or workflow replacement.
- Added `build:pages` and an artifact guard: only compiled `dist/client` is suitable for public deployment.
- Added a Node 22 build-version hint, static cache/MIME headers and API-only Pages Function routing.
- Added a minimal adapter to the **existing** API. Unconfigured endpoints return JSON 503, not the SPA HTML; redirects and HTML upstreams are refused. Cookies/CSRF/idempotency and permission failures are preserved. Financial requests are not retried automatically.
- Added a clear connection/setup screen and static source-deployment fallback, without a fake user, fabricated financial data or assumed database connection.
- Prevented repeated `/auth/me` 401 responses from recursively triggering session-refresh requests.
- Added public read-only deployment checking and setup instructions.

## Tested

- `npm ci`: passed.
- `npm run verify`: passed — **101 tests / 19 files**, typecheck, lint and normal production build.
- `npm run build:pages` and `npm run check:pages`: passed; compiled asset entry point, no server/database/secret material in output.
- `npm run test:e2e`: **9 scenarios passed**, including the existing accounting/approval/role journeys and the new deployment-failure screen/retry.
- Cloudflare Wrangler 4.86.0 compiled the Pages Function successfully under Node 22.
- Actual local Cloudflare runtime: compiled frontend HTTP 200; missing `/api` configuration explicitly returns JSON 503. Desktop and 390 px mobile connection screens rendered without page errors or document overflow. No false login form is shown.
- `npm run db:check`: passed. **No accounting/backend source files or existing database records were changed by this repair.**
- `npm audit --omit=dev`: zero reported vulnerabilities.

The first local Worker start selected a newer compatibility date than the installed runtime supported; it was restarted successfully with an explicit `2025-04-01` local compatibility date. Browser checks initially lacked Linux Chromium libraries; dependencies were installed and the full suite passed on rerun. Neither adjustment changed Cloudflare account settings.

## Not silently changed / still required

No Cloudflare account token or Supabase project details were available. Existing dashboard bindings and secrets were not overwritten. No production Wrangler file was added without first downloading/reviewing that configuration.

The Cloudflare project still needs the administrator to save:

```text
Build command: npm run build:pages
Output directory: dist/client
Root: repository root
Node: 22
```

A real hosted Kilele API must be configured separately as `KILELE_API_ORIGIN` (not a Supabase project URL). Supabase remains **unverified and not integrated**; its schema/auth/transaction/RLS migration must be planned and tested separately. No SQL was run against Supabase, no records migrated, and no credentials embedded in the client.

The `pages.dev` address is sufficient for testing; a purchased domain is not required. A successful static build or a visible setup screen does not constitute a working POS. See [CLOUDFLARE_SETUP.md](CLOUDFLARE_SETUP.md) for the remaining steps and verification criteria.
