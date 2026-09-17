# PostgreSQL / Supabase migration — status and operating guide

**Read this first: what is finished and what is not.**

| Part of the plan                                                                                                     | Status                                                    | Evidence                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Phase 1 — repository preparation (engine switch, dependencies, env, CI)                                              | **Done**                                                  | `server/postgres/db.ts`, `.env.example`, `package.json`, `.github/workflows/ci.yml`                             |
| Phase 2 — PostgreSQL data-access abstraction (pool, async helpers, transactions)                                     | **Done**                                                  | `server/postgres/{db,query,transaction}.ts`                                                                     |
| Phase 3 — schema conversion as versioned migrations                                                                  | **Done, verified against PostgreSQL 18.4**                | `server/postgres/migrations/001_initial_schema.sql`                                                             |
| Phase 4 — financial protection triggers                                                                              | **Done, verified behaviourally (39 tests)**               | `server/postgres/migrations/002_integrity_triggers.sql`, `003_indexes.sql`, `tests/postgres-schema.test.ts`     |
| Migration runner, protection verifier, ledger checker, bootstrap, operator CLI                                       | **Done**                                                  | `server/postgres/{migrate,integrity,check,bootstrap,audit,cli}.ts`                                              |
| Phase 5 — Slice 1: health, connection diagnostics, fail-closed routing, startup sequence                             | **Done, verified on PostgreSQL 18.4**                     | `server/postgres/{slices,app,server}.ts`, `server/app-shared.ts`, `tests/postgres-slice1-health.test.ts`        |
| Phase 5 — Slice 2: bootstrap, authentication, sessions, CSRF, lockout and the audit chain                            | **Done, verified on PostgreSQL 18.4**                     | `server/postgres/{auth,sessions,environment}.ts`, `server/auth-shared.ts`, `tests/postgres-slice2-auth.test.ts` |
| Phase 5 — Slices 3–9: converting the remaining Express modules from synchronous SQLite to the async layer            | **In progress — 2 of 9 done**                             | see [Remaining work](#remaining-work)                                                                           |
| Phase 6 — backup/restore/check utilities on PostgreSQL (`pg_dump`, PITR, restore drill), SQLite→PostgreSQL data copy | **Not started**                                           | `server/backup-engine.ts` and `server/restore.ts` are still SQLite-only                                         |
| Phase 7 — invitation-based staff provisioning                                                                        | **Shipped on SQLite; final naming adopted in PostgreSQL** | commit `f9272ee`, `server/invites.ts`, migration `004_rename_staff_invitations.sql`                             |
| Phase 8 — SaaS/platform tables (`platform_accounts`, `plans`, `subscriptions`, …)                                    | **Not started**                                           | none of those tables exist in either schema                                                                     |

**Consequence, stated plainly:** `DATABASE_ENGINE=postgres` now **starts a real API server** that can
bootstrap a workspace and sign users in — `GET /api/health`, `GET /api/engine`, `GET /api/auth/me`
and the sign-in, sign-out, preview and password routes are live. **Every business route still
answers `503 NOT_MIGRATED`, even with a valid session cookie**: no product, stock, sale, purchase,
approval or report can be read or written on PostgreSQL yet. That is deliberate, so a deployment can
never claim to be on PostgreSQL while silently serving the SQLite ledger, and no client can mistake
an unconverted endpoint for a successful empty result. Startup order is verify connection → apply or
verify migrations → prove the financial protections → seed roles → classify provenance → create the
workspace once → listen; if any step fails the process exits with an operator-readable diagnosis
instead of half-booting. See [Engine guard](#engine-guard), [Slice 1](#slice-1--health-connection-startup)
and [Slice 2](#slice-2--bootstrap-authentication-sessions-csrf-and-audit).

Nothing in this work changes the running product. The default engine is still `sqlite`, the demo
deployment is untouched, and **all 133 SQLite tests pass with no database configured** (95 PostgreSQL
tests skip). With `DATABASE_URL` set, **228 tests pass**: those 133 plus 39 schema/trigger tests, 18
Slice 1 tests and 38 Slice 2 tests.

---

## Architecture (unchanged by this migration)

```
Browser (React client)  →  Express API (Render)  →  Supabase PostgreSQL
        never talks to the database directly ↑
```

- The Express API remains the **only** path to sales, inventory, accounting and staff data.
  Authentication, RBAC, tenant scoping, double-entry posting, row locks, the audit chain and
  approvals all stay server-side.
- Supabase's browser SDK, anonymous keys and Row Level Security are **not** used for money
  operations. No `VITE_*` variable may ever contain a database credential; `DATABASE_URL` is a
  server-only secret.
- Platform administrators get no route to customer financial records: the schema has no
  cross-tenant write path, and Phase 8 (when built) must keep platform tables in a separate
  namespace with no foreign keys into `businesses`-scoped money tables.

---

## What was built

```
server/postgres/
├── db.ts            pool, engine detection, BIGINT type parser, fail-loud guard
├── query.ts         async one/all/scalar/exec/insert, ?→$n translation, SQLite-syntax rejection
├── transaction.ts   one client per financial unit, BEGIN/COMMIT/ROLLBACK, savepoints, FOR UPDATE
├── migrate.ts       versioned runner: advisory lock, per-file transaction, checksum ledger
├── integrity.ts     proves every trigger/index/type guard is installed
├── check.ts         recomputes the ledger (set-based) and verifies the audit hash chain
├── audit.ts         append-only audit writer with a hash chain + actorFor()
├── bootstrap.ts     idempotent initialise + one-time workspace creation
├── cli.ts           ping | migrate | status | protections | check | bootstrap
├── slices.ts        the slice registry: what is converted, what is not, and its scope
├── app.ts           the PostgreSQL Express app: health, engine status, 503 NOT_MIGRATED
├── server.ts        startup: verify → migrate → protections → seed → provenance → workspace → listen
├── environment.ts   preview/operational provenance guard (Slice 2)
├── sessions.ts      hashed session tokens, CSRF tokens, the sign-in attempt ledger (Slice 2)
├── auth.ts          sign-in, sign-out, preview login, password rotation, session middleware (Slice 2)
└── migrations/
    ├── 001_initial_schema.sql        47 tables in foreign-key dependency order
    ├── 002_integrity_triggers.sql    65 triggers: every guard the SQLite ledger enforces
    ├── 003_indexes.sql               the 19 real indexes + 4 documented additions
    └── 004_rename_staff_invitations.sql  user_invites → staff_invitations, renaming its
                                          constraints, indexes and triggers with it
server/passwords.ts   scrypt hashing extracted from db.ts so the PostgreSQL path never
                      imports better-sqlite3 (db.ts re-exports it; no call site changed)
server/app-shared.ts  security headers, body limits, rate limit and the single error contract,
                      shared byte-for-byte by both engines
server/auth-shared.ts scrypt verification, cookie policy, CSRF/Origin gate, protect(), lockout
                      thresholds - security decisions defined once for both engines
server/db-errors.ts   engine-neutral error classification: constraint vs connection failure, and
                      the operator-facing explanation of each
tests/postgres-schema.test.ts        39 behavioural tests against a real server
tests/postgres-engine-guard.test.ts  17 tests that need no server (run everywhere)
tests/postgres-slice1-health.test.ts 18 tests over real HTTP: health, headers, fail-closed routing,
                                     startup diagnostics, boot-and-shutdown on an ephemeral port
tests/postgres-slice2-auth.test.ts   38 tests: one-time bootstrap, provenance, sign-in, lockout,
                                     CSRF, session revocation, concurrency and the audit chain
```

Operator commands:

```bash
npm run db:pg:ping         # connection round trip + server version
npm run db:pg:migrate      # apply migrations from Git
npm run db:pg:status       # which migrations are pending
npm run db:pg:protections  # are all guards installed? (exit 1 if not)
npm run db:pg:check        # recompute the ledger, verify the audit chain (exit 1 if dirty)
npm run db:pg:bootstrap    # migrate + seed roles/permissions + create the owner once
npm run db:pg:test         # PostgreSQL suites: schema, Slice 1, Slice 2, engine guard
```

Production release commands. These run the **built** bundle, so a deploy does not need `tsx` or the
source tree, and they are the exact strings to put in a release/deploy step:

```bash
npm run release:migrate      # node dist/server/postgres/cli.js migrate
npm run release:protections  # node dist/server/postgres/cli.js protections (exit 1 if a guard is missing)
npm run release:pg           # migrate, then protections - the whole release gate in one command
```

---

## Verification evidence

Run in this repository against a **real PostgreSQL 18.4 server**, not a mock or an in-memory
imitation:

- All three migrations apply, in order, inside one transaction each; re-running applies nothing
  (`"applied": []`, 3 skipped) and a changed checksum on an applied file is a hard error.
- `db:pg:protections` reports **ok: true** with **65 triggers, 114 indexes, 105 foreign keys,
  47 tables**.
- 39 behavioural tests pass, including:
  - hand-written `UPDATE inventory SET quantity=…` → _Inventory updates require a matching ledger movement_
  - a movement that does not follow the live position → _Stock changed; reload before posting_
  - a valid movement → position and `version` projected by trigger, `DELETE` of a position refused
  - `UPDATE`/`DELETE` on all 25 immutable tables → _\<table\> records are immutable; request a correction_
  - editing an approval request → _Original approval requests are immutable_; after a decision →
    _A reviewed request cannot be changed_; delete → _Approval history cannot be deleted_
  - cash sessions: only closing a live session is allowed; one open session per user; register
    names matched case- and space-insensitively; delete refused
  - invitations: terms frozen, revoke allowed once, then frozen; delete refused
  - duplicate supplier invoice (different case and padding) → _This supplier invoice already has an active purchase_
  - price change without matching history → refused; with an exactly matching history row → allowed;
    a history row saying `0` where the column is `NULL` → **still refused** (null-safe semantics
    are as exact as SQLite's `IS`)
  - `SELECT … FOR UPDATE`: a second transaction really blocks and is cancelled on
    `statement_timeout` (SQLSTATE 57014)
  - rollback of a whole financial unit, and savepoint rollback of a nested unit without losing
    the outer one
  - `SUM(total_cents)` returns a JavaScript **number**, not a string
  - the integrity checker detects five kinds of tampering (inventory drift, sale header vs items,
    tendered cash, unbalanced journal, tampered audit row) and a dropped trigger
- **Slice 1**, over real HTTP against that same server: `/api/health` answers 200 with the same
  security headers the SQLite app sets, 503 when the database is unreachable, `/api/engine` reports
  the converted and pending slices, six representative unconverted routes (and one that never
  existed) all answer `503 NOT_MIGRATED`, the app refuses to build while the engine is `sqlite`, the
  production/preview validation matches the SQLite app, a wrong password is named without echoing
  the secret, and a full boot on an ephemeral port verifies **65 guard triggers** while creating
  **no** SQLite file. `DATABASE_AUTO_MIGRATE=false` refuses to start with _missing 3 migration(s)_
  and names the release command; `true` applies 001/002/003 on an empty schema.
- **Slice 2**, 38 tests over real HTTP against the same server: a clean database creates the first
  owner, business and branch with a `workspace.created` audit row; a second bootstrap is refused and
  three simultaneous bootstraps leave exactly one workspace; preview provenance blocks promotion and
  operational provenance blocks preview sign-in; a legacy `*@preview.kilele.local` identity is
  detected even in upper case; the bootstrap passphrase never appears in a log, while the email does;
  an uninitialised non-preview database refuses to start; sign-in works (and matches the address in
  any case), a wrong password gives the same 401 as an unknown address, a deactivated user is
  refused even with the right password and their live session dies with the account; hashing stays
  `scrypt-v2` and a legacy hash is upgraded in place with an audit row; rotation requires the current
  password, refuses reuse and revokes every other session; a temporary password blocks every
  protected route with `PASSWORD_CHANGE_REQUIRED`; an unreachable database answers **503
  DATABASE_UNAVAILABLE** and never 401; only the SHA-256 of a session token is stored and the raw
  token appears in no row and no audit text; expiry, logout and rotation all revoke; CSRF, `Origin`
  and `Sec-Fetch-Site` are enforced while reads stay exempt; five failures lock the address for 15
  minutes and the correct password cannot bypass the lock; four concurrent failed logins store 4 (not
  1); six concurrent sign-ins produce six independent valid sessions; the audit chain verifies after
  bootstrap → failure → sign-in → rotation, an ordinary `UPDATE` of an audit row is refused by the
  immutability trigger, a tampered row is still detected by `verifyAudit()`, a rolled-back
  transaction leaves no audit fragment, and `audit()` refuses to run outside a transaction.
- CI reproduces this on every push: job `postgres` starts a `postgres:16` service container with
  `REQUIRE_POSTGRES_TESTS=1`, so a missing database **fails** the build instead of skipping. The same
  job then boots the API from source, signs in over HTTP, and asserts that an authenticated request
  to `/api/sales` still answers `503 NOT_MIGRATED`.

Local run without Docker or a Supabase project:

```bash
docker run --rm -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=kilele -p 5432:5432 postgres:16
DATABASE_URL=postgresql://postgres:dev@127.0.0.1:5432/kilele npm run db:pg:test
```

---

## Conversion rules actually applied

| SQLite                                            | PostgreSQL                                                                | Note                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `PRAGMA foreign_keys = ON`                        | nothing                                                                   | always enforced; there is no off switch to forget                                       |
| `PRAGMA journal_mode = WAL`, `synchronous = FULL` | nothing                                                                   | server durability configuration                                                         |
| `PRAGMA recursive_triggers = ON`                  | nothing                                                                   | existed to stop `INSERT OR REPLACE` evading DELETE guards; REPLACE is rejected outright |
| `INTEGER` (always 64-bit)                         | `BIGINT` for money/quantities, `INTEGER` only for 0/1 flags and `tax_bps` | no column may silently narrow                                                           |
| `INTEGER PRIMARY KEY AUTOINCREMENT`               | `BIGINT GENERATED ALWAYS AS IDENTITY`                                     | `audit_logs.seq` keeps its position as the first column                                 |
| `rowid` ordering                                  | explicit `seq` IDENTITY on `inventory_movements` and `price_history`      | the two ordering-sensitive guards use it                                                |
| `COLLATE NOCASE` on `email`                       | `lower(email)` expression indexes                                         | queries must use `lower(email) = lower($1)`                                             |
| `BLOB` (`documents.content`)                      | `BYTEA`                                                                   | still a Node `Buffer`                                                                   |
| `INSERT OR IGNORE`                                | `INSERT … ON CONFLICT (…) DO NOTHING`                                     | conflict target must be explicit                                                        |
| `INSERT OR REPLACE`                               | **refused**                                                               | it deletes and re-inserts, destroying immutable records                                 |
| `json_extract(col,'$.k')`                         | `col::jsonb ->> 'k'`                                                      | `*_json` columns stay `TEXT` in v1                                                      |
| `json_group_array` / `json_group_object`          | `json_agg` / `json_build_object`                                          |                                                                                         |
| `IFNULL`, `strftime`, `julianday`                 | `COALESCE`, `to_char`, `date_trunc`                                       |                                                                                         |
| `typeof(x)<>'integer'` guards                     | not ported                                                                | PostgreSQL rejects a non-numeric value at the type level                                |
| `sqlite_master` version rows                      | `pg_schema_migrations (name, checksum, applied_at, duration_ms)`          |                                                                                         |
| `PRAGMA integrity_check`, `foreign_key_check`     | `verifyProtections()`                                                     | a client cannot run page-level checks; that is the platform's job                       |

Deliberately preserved for v1, so application code and every existing assertion keep their
meaning: string identifiers, integer KES cents, ISO-8601 UTC **text** timestamps, `*_json` as
**text**, integer 0/1 flags. Moving to `JSONB`, `TIMESTAMPTZ` or native UUIDs is a separate,
later migration with its own tests.

**Table order is the real foreign-key dependency order, not the grouping sketched in the plan.**
`approval_requests` had to move early because eleven tables reference it (`inventory_movements`,
`expenses`, `journal_entries`, `purchase_receipts`, `reconciliation_adjustments` and the six
reversal tables); `cash_sessions` precedes everything carrying `session_id`; `sale_reversals`
precedes `payments`.

### The BIGINT trap

`pg` returns `int8` as a **string** by default, so `SUM(total_cents)` would concatenate instead of
adding. `server/postgres/db.ts` installs a type parser that converts int8 to a number and **throws**
above `Number.MAX_SAFE_INTEGER`. This is safe because the application already caps every amount at
1e12 cents (`shared/validation`), far below 2^53. Do not remove that parser.

---

## Engine guard

`server/db.ts createDb()` — the single choke point used by the API, bootstrap, check, backup,
restore and catalogue update — calls `assertEngineUsable()` first:

| Configuration                                      | Result                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| unset / `sqlite`                                   | today's behaviour, unchanged                                                     |
| `postgres`, no `DATABASE_URL`                      | startup fails: _requires DATABASE_URL_                                           |
| `postgres` with `DATABASE_URL`, SQLite module used | startup fails: _refuses to start rather than silently serving the SQLite ledger_ |
| `postgres`, HTTP route in an unconverted slice     | `503 NOT_MIGRATED` naming the route; never a 404, never an empty success         |
| `mysql`, or any other value                        | startup fails: _must be "sqlite" or "postgres"_                                  |

As each slice is converted, register it so the guard lets it through:

```ts
import { markSliceConverted } from './postgres/db.js';
markSliceConverted('sales'); // only after every sales query is async and tested
```

The guard is tested without a database in `tests/postgres-engine-guard.test.ts`, so it runs in
every CI job and on every laptop.

---

## Slice 1 — health, connection, startup

The first vertical slice is converted: `DATABASE_ENGINE=postgres` starts a real server, proves its
connection, and answers nothing it cannot honour.

**Startup order** (`server/postgres/server.ts`, each step fatal):

1. `ping()` — one real round trip, so credentials, TLS, host, port and database name are all proven
   before anything listens. Failures are translated into operator actions by
   `explainConnectionFailure()`: SQLSTATE `28P01` names the password without echoing it, a
   `pg_hba.conf … no encryption` message (also `28000`) points at `DATABASE_SSL=require` rather
   than misdiagnosing TLS as bad credentials, `3D000` names the missing database, `ENOTFOUND` DNS,
   `ECONNREFUSED` the port or the provider IP allow-list, `ETIMEDOUT`/`ECONNRESET` the network path.
2. **Migrations** — applied from Git when `DATABASE_AUTO_MIGRATE` allows it (default `true` outside
   production, `false` in production, where the release command migrates instead). With it off, a
   schema missing migrations refuses to start and prints _missing 3 migration(s)_ plus the command
   to run; a checksum change on an applied file is a hard error either way.
3. **Protections** — `assertProtections()` requires all **65 guard triggers** (plus the tables,
   foreign keys and indexes) to be present. A database that lost its immutability triggers is not a
   Kilele ledger, so the process exits rather than serving it.
4. **Listen** — only then. The banner states the PostgreSQL version, the database, the trigger
   count and how many migrations this boot applied, and repeats that `DATABASE_PATH` is ignored: no
   SQLite file is opened or created in this mode.

**HTTP contract** (`server/postgres/app.ts`):

| Route                   | Answers                                                                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`       | `200 {status:"ok",currency:"KES",database:"available",engine:"postgres"}` after a live round trip; `503 …database:"unreachable"` when it fails |
| `GET /api/engine`       | `{engine:"postgres",migrated:[…],pending:[{slice,scope}…]}` — migration progress for operators                                                 |
| any other `/api/...`    | `503 {code:"NOT_MIGRATED",route:"GET /api/…",migrated:[…],"error":"This operation is not available yet…"}`                                     |
| anything outside `/api` | the built client when `serveClient` is on, otherwise Express's own 404                                                                         |

`503 NOT_MIGRATED` is deliberate. An unconverted route must never answer `404` (which reads as "this
feature does not exist") or an empty `200` (which reads as "there are no sales today"). Failing
closed means a half-migrated deployment cannot look healthy while refusing to record money.

**One HTTP contract for both engines** (`server/app-shared.ts`): helmet and CSP, a 4 MB JSON body
limit, cookie parsing, 600 requests per 60 seconds per IP, `Cache-Control: no-store`, and the single
error contract are extracted once and installed by both `server/app.ts` (SQLite) and the PostgreSQL
app, so a client cannot tell which engine serves it. Constraint errors are mapped to the same
generic `409 CONFLICT` for SQLite's `SQLITE_CONSTRAINT*` and PostgreSQL's `23502`, `23503`, `23505`,
`23514` and `P0001`; a guard-trigger rejection is logged server-side with its real message and the
client still receives only the generic conflict.

**The slice registry** (`server/postgres/slices.ts`) is the single source of truth for what is
converted: `SLICES` + `SLICE_SCOPE` drive `GET /api/engine`, `assertEngineUsable()`'s error message,
the operator CLI and the tests. A slice is unlocked only by `markSliceConverted(name)` in code, and
the registry is versioned in Git with everything else.

Run it locally:

```bash
DATABASE_ENGINE=postgres DATABASE_URL=postgresql://kilele:kilele@127.0.0.1:5432/kilele npm run dev:api
curl -i localhost:3001/api/health   # 200, and a real round trip happened
curl -i localhost:3001/api/sales    # 503 NOT_MIGRATED - Slice 6 is not converted yet
```

---

## Slice 2 — bootstrap, authentication, sessions, CSRF and audit

`server/postgres/{environment,sessions,auth}.ts` are the async port of `server/environment.ts` and
`server/auth.ts`; `server/postgres/bootstrap.ts` (built in Phase 3) is now wired into startup.

**Routes that are live on PostgreSQL:**

| Route                     | Behaviour                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `POST /api/auth/login`    | scrypt verification, lockout, legacy-hash upgrade, one session, `auth.login` audit |
| `POST /api/auth/preview`  | preview workspaces only; refuses to exist outside `PREVIEW_MODE=true`              |
| `POST /api/auth/logout`   | revokes the session, clears the cookie, writes `auth.logout`                       |
| `POST /api/auth/password` | requires the current password, refuses reuse, revokes **every** session, reissues  |
| `GET /api/auth/me`        | actor, CSRF token, business and branch                                             |
| every other `/api/...`    | `503 NOT_MIGRATED` — including with a valid session cookie                         |

**What is shared, so the two engines cannot drift.** `server/auth-shared.ts` holds the scrypt
verification (including the legacy `salt:key` form and the timing-safe comparison against a dummy
hash for unknown addresses), the cookie policy (`httpOnly`, `SameSite=Strict`, `Secure`,
partitioned only for embedded previews, 12-hour `maxAge`), the lockout thresholds (5 failures, 15
minutes), the rate limits (20 sign-ins and 10 password changes per 15 minutes), `protect()` and the
CSRF/`Origin`/`Sec-Fetch-Site` gate. Both HTTP surfaces import the same functions, so a client
cannot tell which engine authenticated it.

**Three properties that are stronger on PostgreSQL than they were on SQLite:**

1. **Failed-sign-in bookkeeping is committed, then the 401 is raised.** The attempt counter, the
   lockout and the `auth.login_failed` audit row are written in a transaction that COMMITs, and the
   rejection happens afterwards. Throwing inside the transaction would roll the counter back and
   make brute force free.
2. **The attempt counter increments in SQL, not in JavaScript.** `ON CONFLICT (email) DO UPDATE`
   with the arithmetic in the statement means two simultaneous bad logins cannot both store `1`; the
   second writer blocks on the unique index and adds to the committed value. Verified: four
   concurrent failures store 4.
3. **Every unit is one transaction on one client.** Sign-in, sign-out, rotation, bootstrap and the
   audit row that describes each of them succeed or fail together, and `audit()` still refuses to run
   outside a transaction because the hash chain is global and needs its advisory lock.

**Environment provenance** (`server/postgres/environment.ts`) reads the same three signals as
SQLite — the `environment_markers` row, an `auth.preview_login` audit row, and a legacy
`*@preview.kilele.local` identity — and refuses in the same words: a preview database cannot be
promoted to live books, an operational database cannot accept preview authentication, and preview
plus production is prohibited outright. `lower(email) LIKE` replaces SQLite's case-insensitive
`LIKE`, so an upper-case legacy identity cannot slip through.

**Startup now finishes the job** (`server/postgres/server.ts`): after the migrations and the guard
triggers are verified it seeds roles and permissions (idempotent, one transaction), classifies the
environment, and creates the owner workspace **once** — a throwaway owner in preview mode, or
`BOOTSTRAP_NAME`/`BOOTSTRAP_EMAIL`/`BOOTSTRAP_PASSWORD`/`BUSINESS_NAME` everywhere else, with the
same refusal message the SQLite startup uses. Only the email is logged.

**Naming.** Migration `004_rename_staff_invitations.sql` renames `user_invites` to
`staff_invitations`, plus its constraints, indexes and the three invitation triggers, so the final
product naming is in place before any invitation code runs on PostgreSQL. See
[Two deviations](#two-deviations-from-the-plan-you-should-know-about) for what happens on SQLite.

---

## Production deploy order (Render + Supabase)

The safe sequence, and the exact commands — confirmed from `package.json` and the built output, not
guessed. `dist/server/migrate.js` **does not exist**; the migration CLI is bundled as
`dist/server/postgres/cli.js`.

```
Build image → run migrations → verify schema and guard triggers → start API
```

| Render field        | Value                                                                                                                                                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build command       | `npm ci && npm run build`                                                                                                                                                                                                                      |
| **Release command** | `npm run release:pg` (= `node dist/server/postgres/cli.js migrate && … protections`)                                                                                                                                                           |
| Start command       | `npm start` (= `NODE_ENV=production node dist/server/index.js`)                                                                                                                                                                                |
| Environment         | `DATABASE_ENGINE=postgres`, `DATABASE_URL` (secret), `DATABASE_AUTO_MIGRATE=false`, `DATABASE_SSL=require` (or `verify-full`), `NODE_ENV=production`, `APP_ORIGIN=https://<your-host>`, `PUBLIC_HOST`, `TRUST_PROXY` only behind a known proxy |

Why the release command cannot be skipped:

- With `DATABASE_AUTO_MIGRATE=false` (the production default) an unmigrated database makes the API
  **exit before listening**: _"The database is missing 4 migration(s): …"_. Verified against a
  virgin PostgreSQL database.
- Even after migrating, the API refuses to listen unless **all 65 guard triggers** are present, so a
  database that lost its protections cannot serve a till.
- `npm run release:protections` exits non-zero when a guard is missing, which fails the deploy
  instead of shipping a ledger without its immutability rules.
- A rolling restart can never apply a migration by itself in production; schema changes are applied
  once, by the release step, from the SQL that is versioned in Git.

One-time bootstrap on a fresh Supabase database: run the release command, then either set
`BOOTSTRAP_NAME`, `BOOTSTRAP_EMAIL`, `BOOTSTRAP_PASSWORD` (12+ characters) and `BUSINESS_NAME` for a
single start, or run `npm run db:pg:bootstrap` with those variables present and then remove them.
Bootstrap is one-time only: a second run creates nothing and changes nothing.

**What cannot be verified from this repository.** There is no `render.yaml` blueprint here, so the
Render service is configured in the dashboard, and neither the Render settings nor a staging
deployment can be read from this sandbox. The two staging checks — `/api/health` returning
`engine: "postgres"` and `/api/sales` returning `NOT_MIGRATED` — are reproduced exactly by CI on
every push, and the commands to confirm them against a live host are:

```bash
curl -s https://<staging-host>/api/health    # expect "engine":"postgres" and "database":"available"
curl -si https://<staging-host>/api/sales    # expect HTTP 503 and "code":"NOT_MIGRATED"
```

---

## Remaining work

Converted **one vertical slice at a time**, with the whole suite green at each step. Every slice
means: rewrite that module's queries against `server/postgres/query.ts`, wrap each financial unit
in `transaction()`, convert its tests to `await`, and mark the slice converted.

| Slice                                                               | Modules to convert                                                                                                                                                                                                          | Depends on |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **1 — done.** Connection, health, migrations, guard verification    | `server/index.ts` health route + startup, `server/postgres/{app,server,slices}.ts`, `server/app-shared.ts`; `server/environment.ts` moved into Slice 2 because its provenance guard reads `users` and `environment_markers` | —          |
| **2 — done.** Bootstrap, authentication, sessions, CSRF and lockout | `server/postgres/{bootstrap,auth,sessions,environment}.ts`, `server/auth-shared.ts`, `server/db-errors.ts`; ports of `server/db.ts` (bootstrap/actorFor) and `server/auth.ts`                                               | 1          |
| 3 Staff, roles, permissions and tenant scope                        | `server/management.ts`, `server/invites.ts`, `server/permissions.ts`; serves `/api/staff/invitations`                                                                                                                       | 2          |
| 4 Products, catalogue, pricing and barcodes                         | `server/products.ts`, `server/catalogue.ts`, price history                                                                                                                                                                  | 2          |
| 5 Inventory, stock locking and weighted-average costing             | `server/stock-engine.ts`, movement ledger, counts, wastage                                                                                                                                                                  | 4          |
| 6 Sales, payments, journals, receipts and idempotency               | `server/sales.ts`, payments, journals, receipts, cash sessions, idempotency keys                                                                                                                                            | 5          |
| 7 Purchases, expenses and reconciliation                            | `server/purchases.ts`, `server/expenses.ts`, supplier payments, reconciliations                                                                                                                                             | 5          |
| 8 Approvals, reversals, reports and analytics                       | `server/approvals.ts`, all six reversal paths, `server/reports.ts`, `server/analytics.ts`, exports, integrity API                                                                                                           | 6, 7       |
| 9 Documents, backups, restore and production operations             | documents, `backup-engine.ts` → `pg_dump`/PITR, `restore.ts`, `check.ts` parity, **SQLite→PostgreSQL data copy**                                                                                                            | 8          |
| SaaS platform tables (after Slice 9)                                | `platform_accounts`, `plans`, `subscriptions`, `subscription_events`, `platform_admins` - separate namespace, no foreign keys into business money tables                                                                    | 9          |

`integrity()` in `server/postgres/check.ts` states its own coverage: the result includes a
`checks.pending` list naming the six core.ts checks not yet ported (expense reversal vs original,
purchase header/items, closing snapshot arithmetic, approval reviewer metadata, the
ledger-to-account-map recomputation, supplier payment/refund reconciliation). An integrity report
that looks complete while skipping purchases would be worse than no report, so the gaps are
printed rather than hidden.

### Code changes every slice will hit

These were found by verification, not guessed:

1. **`COLLATE NOCASE` is a syntax error in PostgreSQL.** `server/invites.ts` and `server/auth.ts`
   use `WHERE email = ? COLLATE NOCASE`; it becomes `WHERE lower(email) = lower($1)`. Emails are
   already lower-cased at every write boundary, so no data change is needed.
2. **Everything becomes `await`.** `one/all/insert/exec` are async, so each converted function,
   its callers and its tests change signature. This is the bulk of the work.
3. **A financial unit is one transaction on one client.** `transaction(async (tx) => …)` passes
   the same connection to every statement. Never acquire a second client mid-unit.
4. **Stock writes take row locks.** `tx.lockInventory(businessId, branchId, productIds)` issues
   `SELECT … FOR UPDATE` with product ids sorted, so two concurrent sales cannot deadlock or both
   post the same delta.
5. **`audit()` must run inside a transaction.** The chain is global, so the writer takes
   `pg_advisory_xact_lock` for the duration; outside a transaction it throws.
6. **`INSERT OR REPLACE` is rejected by `query.ts`.** Rewrite as an explicit
   `ON CONFLICT … DO UPDATE` with a named target — and never against an immutable table.
7. **`rowid` is gone.** Ordering uses the explicit `seq` columns.
8. **Reports must not assume SQLite date functions.** `strftime`/`julianday` → `to_char`/`date_trunc`.
9. **`documents.content` is `BYTEA`.** PDFKit buffers work unchanged; do not base64 them into text.

### Deployment cutover (operator tasks that cannot be done from this repository)

1. Create the Supabase project (or managed PostgreSQL) and the Render service. Choose a region
   near the users; a Nairobi till cannot tolerate a round trip to another continent per sale.
2. Set on the **server only**: `DATABASE_ENGINE=postgres`, `DATABASE_URL` (session/pooled
   connection string), `DATABASE_SSL=require` (or `verify-full` with the platform CA),
   `DATABASE_POOL_MAX` below the platform connection limit, leaving room for the migration CLI.
3. Render release command: `node dist/server/postgres/cli.js migrate && node dist/server/postgres/cli.js protections`.
   A deploy must stop if either fails.
4. First run only: `node dist/server/postgres/cli.js bootstrap` with `BOOTSTRAP_*` set, then remove
   those variables. Bootstrap creates a workspace **once** and refuses if any user exists.
5. Backups: enable the platform's PITR/daily backups, and rehearse `pg_dump` → restore into a
   scratch schema → `db:pg:check`. A backup that has never been restored is not a backup.
6. **Existing data:** there is no SQLite→PostgreSQL copy tool yet (Phase 6). A new deployment
   bootstraps empty; the current demo/preview database cannot be moved until that tool exists and
   has been verified against `db:pg:check`.
7. Never apply schema changes from the Supabase SQL editor. Every change is a numbered file in
   `server/postgres/migrations`, reviewed in a pull request; the runner records its checksum and
   refuses to re-apply an edited file.

### Two deviations from the plan you should know about

- **Branch.** This session is pinned to `arena/01a0754f-kilele-retail-os`; it cannot create or push
  `feature/postgres-supabase-migration`. The work is committed to the pinned branch and reaches
  `main` through the existing pull request. If you want the branch name from the plan, say so and
  it can be recreated from these commits in a session that is not pinned.
- **Phase 7 naming — resolved in PostgreSQL, deferred on SQLite.** Invitation-based staff
  provisioning already shipped on SQLite (commit `f9272ee`) as `user_invites` + `/api/invites`, with
  hashed tokens, 7-day expiry, per-branch limits, duplicate email revocation and super-admin-only
  admin invitations. Migration `004_rename_staff_invitations.sql` renames the PostgreSQL table to
  **`staff_invitations`** — together with its constraints, indexes and trigger names — so the final
  KilelePro naming exists before any invitation code runs against PostgreSQL, and Slice 3 will serve
  **`/api/staff/invitations`**.
  The SQLite side keeps `user_invites` and `/api/invites` for now, because renaming a table there
  would leave existing invitations behind in the old table of a live database (`CREATE TABLE IF NOT
EXISTS` would simply make a new empty one). When Slice 3 lands, the SQLite app will serve
  `/api/staff/invitations` as the canonical route with `/api/invites` kept as a deprecated alias for
  one release, and the SQLite→PostgreSQL copy tool must map `user_invites` → `staff_invitations`.
  Nothing is lost either way; the mapping is recorded here so it is not rediscovered later.
