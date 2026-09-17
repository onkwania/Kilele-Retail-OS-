# Connection audit — repository, Supabase and "is it wired together?"

**Date:** 2026-09-17 · **Audited commit:** `810b350` (`main`, merge of PR #2) · **Method:** the repository
was cloned and its own commands were executed. Every number below is measured output, not a claim
copied from documentation.

This closes the two questions left open earlier:

1. _What is actually in the GitHub repository?_ — previously unauditable because `github.com` HTML
   pages block automated fetching.
2. _Does the code's configuration point at Supabase project `aqabofwdehhqyxxgsnpb`?_

---

## Verdict

**The application on `main` is complete, internally consistent and working.** It builds, typechecks,
lints, passes its whole automated suite and runs end to end against a real SQLite ledger.

**The empty Supabase project is not a broken wire — it is an unused resource.** No code on `main`
connects to Supabase, references a project ref, or contains a `DATABASE_URL`. Kilele's database is a
local SQLite file selected by `DATABASE_PATH`. There is therefore **no mismatch to fix**: nothing in
the product expects `aqabofwdehhqyxxgsnpb` to be populated, and nothing broke because it is empty.

The Supabase/PostgreSQL work does exist — it is on **open PR #1**, deliberately incomplete and
fail-closed, and it has never been pointed at any Supabase instance. Details in
[Supabase: what is and is not connected](#supabase-what-is-and-is-not-connected).

---

## 1. GitHub repository — audited

Reachable via the GitHub API and `gh` (the earlier block was on HTML pages, not the API).

| Item           | Value                                                                         |
| -------------- | ----------------------------------------------------------------------------- |
| Repository     | [`onkwania/Kilele-Retail-OS-`](https://github.com/onkwania/Kilele-Retail-OS-) |
| Visibility     | **Public** (not private, as previously suspected)                             |
| Created        | 2026-09-05T16:01:33Z                                                          |
| Last push      | 2026-09-17T03:42:55Z                                                          |
| Default branch | `main`                                                                        |
| Size           | 603 KB (Git); 2.8 MB working tree excluding `node_modules`/`dist`             |
| Pull requests  | #1 **open**, #2 **merged** 2026-09-16T20:38:09Z                               |

`main` is a full application, not a stub: 26 server modules, 15 React pages, `server/schema.sql`,
Docker/Caddy deployment templates, 19 test files and a 9-scenario Playwright suite.

### Structure

```
server/      Express API + SQLite ledger (26 modules, schema.sql)
src/         React 19 client (15 pages, 8 components, router, state, API layer)
shared/      client/server shared operation contracts
functions/   Cloudflare Pages adapter (proxy only — no database)
tests/       19 vitest files      e2e/  9 Playwright scenarios
docs/        18 audit/ops/deployment documents (19 including this one)
deploy/      compose.yaml, Caddyfile, backup.sh
```

No `TODO`, `FIXME`, `XXX`, `HACK`, "not implemented" or stub markers exist anywhere in
`server/`, `src/`, `shared/`, `functions/` or `scripts/` — **0 hits**.

---

## 2. Executed verification on `main`

| Command               | Result                                                           |
| --------------------- | ---------------------------------------------------------------- |
| `npx vitest run`      | **101 passed / 101**, 19 files, 0 failed (80.9 s)                |
| `npx tsc --noEmit`    | **clean**, exit 0                                                |
| `npx eslint .`        | **clean**, exit 0, no warnings                                   |
| `npm run build`       | **clean** — client 479.29 kB (139.13 kB gzip) + 6 server bundles |
| `npm run check:pages` | **pass** — `dist/client`, 8 files, 1 compiled entrypoint         |
| `npm run db:check`    | **`ok: true`**, 0 errors, 3 audit events                         |
| `npm audit`           | **0 vulnerabilities** (also 0 with `--omit=dev`)                 |

14 runtime dependencies, all mainstream and current: `express@5`, `better-sqlite3@12`, `react@19`,
`zod@4`, `helmet`, `pdfkit`, `express-rate-limit`, `cookie-parser`, `dotenv`.

### Live end-to-end smoke test

Both services were started (`npm run dev`) and exercised over HTTP through the Vite proxy, exactly
as a browser does:

| Check                                                  | Observed                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `GET /api/health`                                      | `{"status":"ok","currency":"KES","database":"available"}`                                                          |
| `GET /api/auth/me` (anonymous)                         | `{"user":null,"csrf":null,"preview":true,…}`                                                                       |
| `GET /api/products` (anonymous)                        | **401** — correctly refused                                                                                        |
| `POST /api/auth/preview`                               | **200** — session + 64-char CSRF issued, role `super_admin`                                                        |
| `GET /api/products` (authenticated)                    | **200 — 140 listings**                                                                                             |
| `GET /api/dashboard` (authenticated)                   | **200** — honest all-zero financial state                                                                          |
| Authenticated `POST` without CSRF token                | **403 `CSRF_REJECTED`**                                                                                            |
| Authenticated `POST` from a cross-site `Origin`        | **403 `CSRF_REJECTED`**                                                                                            |
| Authenticated `POST` from an `.e2b.app` preview origin | **not** origin-rejected (reached validation: 400 idempotency key)                                                  |
| `DELETE /api/sales/:id`                                | **404** — no destructive route exposed                                                                             |
| `GET /src/main.tsx`                                    | **200**, `text/javascript` (the Cloudflare Pages MIME failure in `docs/CLOUDFLARE_SETUP.md` does not occur in dev) |

Security headers are present on every response: a full CSP, HSTS with `includeSubDomains`,
`X-Content-Type-Options: nosniff`, `frame-ancestors`, `referrer-policy: no-referrer`,
`Cross-Origin-Opener/Resource-Policy`, plus `RateLimit` headers (600/60 s).

### Catalogue claims verified against live data

`README.md` makes unusually specific promises about the starter catalogue. All were checked against
the running API rather than accepted:

| Claim                                            | Measured                                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 140 source-linked listings                       | **140**, and **140/140** carry a `source_url` (`source_status: source_reference`)                                              |
| No selling or buying prices                      | **0** of 140 have `cost_cents`, `selling_cents`, `wholesale_cents` or `promo_cents` set; `cost_configured` is false on all 140 |
| No invented barcodes                             | **0** of 140 have a barcode                                                                                                    |
| Unset tax treatment                              | `tax_mode = unset` on **140/140**; `tax_bps` non-zero on **0**                                                                 |
| Zero stock                                       | **0** of 140 have non-zero `stock`                                                                                             |
| Exactly one accessory's package info unconfirmed | **`Homezaza Mini Bottle Opener DH1839`** is the only `unverified` row; the other 139 are `recorded_unconfirmed`                |

This is a codebase whose documentation survives being tested against it.

---

## 3. Supabase: what is and is not connected

### Nothing on `main` touches Supabase

A full-text search of `package.json`, `.env.example`, `server/`, `functions/`, `src/`, `shared/`,
`deploy/` and `Dockerfile` finds **no Supabase dependency, no client, no project ref, no
`DATABASE_URL`, no `SUPABASE_URL`**. The only two occurrences of the word "Supabase" in shipped code
are warnings _against_ assuming it:

- `functions/api/[[path]].ts:116` — _"Do not inject Supabase keys or rewrite Origin to bypass the
  upstream security policy."_
- `src/components/ConnectionProblem.tsx:48` — _"A Supabase project alone does not provide Kilele's
  API or migrate the existing SQLite ledger."_

The project ref `aqabofwdehhqyxxgsnpb` appears **nowhere** in the repository. The only database
setting is `DATABASE_PATH`, defaulting to `./data/kilele.sqlite`, used consistently by
`index.ts`, `bootstrap.ts`, `check.ts`, `backup.ts`, `restore.ts` and `catalogue-update.ts`.

**So the answer to "does the code point at this project?" is: no, and it was never supposed to.** An
empty Supabase instance is the correct, expected state for `main`. It is not evidence of a failed
deployment.

### Where the Supabase work actually is: open PR #1

PR #1 (`arena/01a0754f-kilele-retail-os`, **+10 812 / −435 across 63 files**, CI green, mergeable,
clean) has grown well past its original title. It contains:

- **Real CI** (`.github/workflows/ci.yml`): test → typecheck → lint → format → build → Pages guard.
- Closure of five audit gaps, documented in `docs/GAP_AUDIT.md`.
- **Invitation-based staff provisioning** (`server/invites.ts`, `src/pages/AcceptInvite.tsx`).
- **A PostgreSQL/Supabase backend** — `server/postgres/` with pool, async query layer
  (`?`→`$n` translation, SQLite-syntax rejection), transactions with `SELECT … FOR UPDATE`,
  a checksum-ledger migration runner, integrity verifier, ledger checker, bootstrap and operator CLI.
- **Four numbered migrations**: 47 tables, 65 protection triggers, 19 indexes, plus a rename.
- Engine selection via `DATABASE_ENGINE` (default `sqlite`) and a server-only `DATABASE_URL`.
- `docs/POSTGRES_MIGRATION.md` — an honest status table.

Its own stated position, which the diff supports:

| Phase                                                                             | Status per PR #1                        |
| --------------------------------------------------------------------------------- | --------------------------------------- |
| 1–4 Repo prep, data layer, schema, financial triggers                             | Done (verified against PostgreSQL 18.4) |
| Migration runner, integrity, ledger check, bootstrap, CLI                         | Done                                    |
| 5 Slice 1 — health, diagnostics, fail-closed routing, startup                     | Done                                    |
| 5 Slice 2 — bootstrap, auth, sessions, CSRF, lockout, audit chain                 | Done                                    |
| **5 Slices 3–9 — staff, products, inventory, POS, purchases, approvals, reports** | **In progress: 2 of 9**                 |
| 6 Backup/restore on PostgreSQL, SQLite→PostgreSQL data copy                       | Not started                             |
| 8 SaaS/platform tables                                                            | Not started                             |

Consequently `DATABASE_ENGINE=postgres` boots a real server where health, engine status and all
authentication routes work, while **every business route returns `503 NOT_MIGRATED` even with a valid
session**. That is intentional fail-closed design, so a deployment can never appear to be on
PostgreSQL while silently serving the SQLite ledger.

PR #1's own numbers: 133 SQLite tests pass with no database configured (95 PostgreSQL tests skip);
with `DATABASE_URL` set, 228 pass.

### Version compatibility with your Supabase project

The Supabase instance was reported as **PostgreSQL 17.6.1** while PR #1 documents verification
against **PostgreSQL 18.4** — a gap worth closing before cutover. Two findings reduce that concern:

- PR #1's CI runs its PostgreSQL suite against a real **`postgres:16`** server, i.e. _older_ than
  your 17.6.1, so the migrations are exercised below your version too.
- A static scan of all four migrations and every file under `server/postgres/` found **no
  PostgreSQL-18-only constructs**: no `uuidv7()`, no `MERGE`, no `NULLS NOT DISTINCT`, no
  `WITHOUT OVERLAPS`/temporal constraints, no `RETURNING OLD`, no `NOT ENFORCED`, no
  `VIRTUAL GENERATED` columns, no `io_method` settings. The newest feature used is
  `GENERATED ALWAYS AS IDENTITY` (PostgreSQL 10+). There is also **no hard minimum-version
  assertion** in the code — `ping()` merely reports `version()`.

Nothing detected would block PostgreSQL 17.6.1. This is a static conclusion: it could not be
confirmed behaviourally, because no PostgreSQL server is reachable from the audit environment.
`npm run db:pg:ping` against the real instance is the one-command check.

### Remaining cutover steps that cannot be done from the repository

Per `docs/POSTGRES_MIGRATION.md`, and still outstanding: finish slices 3–9; build the Phase 6
SQLite→PostgreSQL data copy (until then a PostgreSQL deployment bootstraps **empty** — the existing
catalogue/preview data cannot be moved); set `DATABASE_ENGINE=postgres`, `DATABASE_URL`,
`DATABASE_SSL`, `DATABASE_POOL_MAX` **server-side only**; run `cli.js migrate && cli.js protections`
as a release command that aborts the deploy on failure; run `cli.js bootstrap` once; and rehearse
`pg_dump` → restore → `db:pg:check`. Schema must never be edited through the Supabase SQL editor —
every change is a numbered migration file whose checksum the runner verifies.

Also worth noting: Supabase is in **eu-west-1**. The same document warns that a Nairobi till cannot
tolerate a trans-continental round trip per sale. Region choice is a live latency question for the
POS path, independent of correctness.

---

## 4. Genuine defects found on `main`

Only one, and it is CI hygiene rather than product behaviour.

**Both files in `.github/workflows/` are unmodified GitHub templates, and one fails on every push.**

- `azure-container-webapp.yml` triggers on **every push to `main`**, builds and publishes a Docker
  image to `ghcr.io`, then deploys to an app literally named `your-app-name` using an
  `AZURE_WEBAPP_PUBLISH_PROFILE` secret that does not exist. All **3** runs on `main` have failed
  (13–21 s each), including the merge of PR #2. Every commit produces a red check and an unintended
  public container image build.
- Separately, that target contradicts the supported deployment. `docs/DEPLOYMENT.md` requires one
  process on a **local persistent SQLite volume** and forbids ephemeral/serverless storage, network
  shares and multiple replicas. Azure Web App for Containers storage is ephemeral and scales out, so
  a financial ledger there can be lost or split on restart/scale-out.
- `generator-generic-ossf-slsa3-publish.yml` signs **SLSA level-3 provenance over dummy artifacts**
  (`echo "artifact1" > artifact1`) on every release — an attestation describing nothing real.

**Already fixed on PR #1**, which disables both triggers, documents why, and adds real CI. Merging
PR #1 resolves this; changing the same files on another branch would only create a conflict.

### Documentation drift (cosmetic, already corrected on PR #1)

`README.md:9` claims "**86 automated tests and eight real-browser scenarios**". Measured on `main`:
**101 tests across 19 files** and **9 Playwright scenarios**. `docs/SECOND_PASS_AUDIT.md:91` repeats
the 86/18 figure. The suite grew without the prose catching up. PR #1 rewrites the line to
132 tests / 23 files / 10 scenarios and marks the old figure superseded, so this needs no separate
fix.

---

## 5. What could not be verified here

Stated rather than glossed over:

- **The Supabase instance itself.** Its state (ACTIVE_HEALTHY, eu-west-1, PostgreSQL 17.6.1, zero
  tables/migrations/edge functions, no security advisories) comes from the earlier account-level
  check, not from this audit. No Supabase credentials or management API are available in this
  environment. That reported state is fully consistent with what the code requires — an unused
  project.
- **The browser suite.** `npm run test:e2e` needs a Chromium download, which is blocked here. The 9
  scenarios were read but not executed. The API-level equivalents of their assertions were verified
  live instead.
- **The PostgreSQL suite.** No PostgreSQL server is reachable, so PR #1's 95 PostgreSQL tests were
  not run. PR #1's own CI has run them green against `postgres:16`.
- **External acceptance gates** that `docs/ACCEPTANCE.md` already lists as open and that no amount of
  code work can close: KRA eTIMS fiscal certification, M-Pesa/card/bank provider integrations,
  receipt-printer and scanner hardware acceptance, and a formal penetration test. The application
  _records_ manually confirmed payments; it does not initiate or verify transfers, and its receipts
  are not eTIMS fiscal invoices.

### Audit-environment note

`npm ci` fails in a sandbox without access to `nodejs.org` and GitHub release assets, because
`better-sqlite3` falls back to a source build that needs downloaded Node headers. This is an
environment limitation, **not a repository defect** — on a normal machine the prebuilt binary is
fetched. It was worked around with `npm ci --ignore-scripts` followed by
`npx node-gyp rebuild --release --nodedir=/usr/local`, producing a working module
(SQLite 3.53.2). Worth knowing only if CI ever runs behind a restrictive egress policy.

---

## Recommendation

1. **Use `main` as-is.** It is a working, tested, coherent product. Nothing about it is waiting on
   Supabase.
2. **Merge PR #1.** It is green and mergeable, it fixes the only real defect found (CI), and it
   ships the CI pipeline that turns "the commands were run manually" into enforced verification.
3. **Treat Supabase as a decision, not a repair.** Either stay on SQLite with the documented
   single-host persistent-volume deployment — which is fully supported today — or commit to
   finishing slices 3–9 plus the Phase 6 data-copy tool before any cutover. Pointing the app at
   `aqabofwdehhqyxxgsnpb` now would buy nothing: business routes would return `503 NOT_MIGRATED`.
4. **If PostgreSQL is the direction**, run `npm run db:pg:ping` and `db:pg:migrate` against a
   **staging** Supabase project first to confirm behaviour on 17.6.1, and reconsider region for POS
   latency.
5. **Do not** paste `server/schema.sql` into the Supabase SQL editor, and never place a
   service-role key or `DATABASE_URL` in a `VITE_*` variable. Both are called out in the repository's
   own docs and both would be real security regressions.
