# PostgreSQL / Supabase migration — status and operating guide

**Read this first: what is finished and what is not.**

| Part of the plan                                                                                                     | Status                                      | Evidence                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Phase 1 — repository preparation (engine switch, dependencies, env, CI)                                              | **Done**                                    | `server/postgres/db.ts`, `.env.example`, `package.json`, `.github/workflows/ci.yml`                         |
| Phase 2 — PostgreSQL data-access abstraction (pool, async helpers, transactions)                                     | **Done**                                    | `server/postgres/{db,query,transaction}.ts`                                                                 |
| Phase 3 — schema conversion as versioned migrations                                                                  | **Done, verified against PostgreSQL 18.4**  | `server/postgres/migrations/001_initial_schema.sql`                                                         |
| Phase 4 — financial protection triggers                                                                              | **Done, verified behaviourally (39 tests)** | `server/postgres/migrations/002_integrity_triggers.sql`, `003_indexes.sql`, `tests/postgres-schema.test.ts` |
| Migration runner, protection verifier, ledger checker, bootstrap, operator CLI                                       | **Done**                                    | `server/postgres/{migrate,integrity,check,bootstrap,audit,cli}.ts`                                          |
| Phase 5 — Slices 1–9: converting the ~20 Express modules from synchronous SQLite to the async layer                  | **Not started**                             | see [Remaining work](#remaining-work)                                                                       |
| Phase 6 — backup/restore/check utilities on PostgreSQL (`pg_dump`, PITR, restore drill), SQLite→PostgreSQL data copy | **Not started**                             | `server/backup-engine.ts` and `server/restore.ts` are still SQLite-only                                     |
| Phase 7 — invitation-based staff provisioning                                                                        | **Already shipped, earlier, on SQLite**     | commit `f9272ee`, `server/invites.ts`, `tests/invites.test.ts`                                              |
| Phase 8 — SaaS/platform tables (`platform_accounts`, `plans`, `subscriptions`, …)                                    | **Not started**                             | none of those tables exist in either schema                                                                 |

**Consequence, stated plainly:** `DATABASE_ENGINE=postgres` **refuses to start the API today**. The
database layer is finished and proven; the Express modules that use it are not converted yet. The
guard exists so that a deployment can never claim to be on PostgreSQL while silently serving the
SQLite file. See [Engine guard](#engine-guard).

Nothing in this work changes the running product. The default engine is still `sqlite`, the demo
deployment is untouched, and all 132 existing tests still pass unchanged.

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
└── migrations/
    ├── 001_initial_schema.sql        47 tables in foreign-key dependency order
    ├── 002_integrity_triggers.sql    65 triggers: every guard the SQLite ledger enforces
    └── 003_indexes.sql               the 19 real indexes + 4 documented additions
server/passwords.ts   scrypt hashing extracted from db.ts so the PostgreSQL path never
                      imports better-sqlite3 (db.ts re-exports it; no call site changed)
tests/postgres-schema.test.ts        39 behavioural tests against a real server
tests/postgres-engine-guard.test.ts  17 tests that need no server (run everywhere)
```

Operator commands:

```bash
npm run db:pg:ping         # connection round trip + server version
npm run db:pg:migrate      # apply migrations from Git
npm run db:pg:status       # which migrations are pending
npm run db:pg:protections  # are all guards installed? (exit 1 if not)
npm run db:pg:check        # recompute the ledger, verify the audit chain (exit 1 if dirty)
npm run db:pg:bootstrap    # migrate + seed roles/permissions + create the owner once
npm run db:pg:test         # behavioural suite (needs DATABASE_URL)
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
- CI reproduces this on every push: job `postgres` starts a `postgres:16` service container with
  `REQUIRE_POSTGRES_TESTS=1`, so a missing database **fails** the build instead of skipping.

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

| Configuration                                        | Result                                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| unset / `sqlite`                                     | today's behaviour, unchanged                                                     |
| `postgres`, no `DATABASE_URL`                        | startup fails: _requires DATABASE_URL_                                           |
| `postgres` with `DATABASE_URL`, module not converted | startup fails: _refuses to start rather than silently serving the SQLite ledger_ |
| `mysql`, or any other value                          | startup fails: _must be "sqlite" or "postgres"_                                  |

As each slice is converted, register it so the guard lets it through:

```ts
import { markSliceConverted } from './postgres/db.js';
markSliceConverted('sales'); // only after every sales query is async and tested
```

The guard is tested without a database in `tests/postgres-engine-guard.test.ts`, so it runs in
every CI job and on every laptop.

---

## Remaining work

Converted **one vertical slice at a time**, with the whole suite green at each step. Every slice
means: rewrite that module's queries against `server/postgres/query.ts`, wrap each financial unit
in `transaction()`, convert its tests to `await`, and mark the slice converted.

| Slice                   | Modules to convert                                                                                    | Depends on |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | ---------- |
| 1 Health & connection   | `server/index.ts` health route, `server/environment.ts`                                               | —          |
| 2 Bootstrap & auth      | `server/db.ts` (bootstrap/actorFor), `server/auth.ts`, `server/sessions.ts`                           | 1          |
| 3 Staff & permissions   | `server/management.ts`, `server/invites.ts`, `server/permissions.ts`                                  | 2          |
| 4 Products & pricing    | `server/products.ts`, `server/catalogue.ts`                                                           | 2          |
| 5 Inventory             | `server/stock-engine.ts`, movement ledger, counts                                                     | 4          |
| 6 POS sales             | `server/sales.ts`, payments, receipts, cash sessions                                                  | 5          |
| 7 Purchases & expenses  | `server/purchases.ts`, `server/expenses.ts`, supplier payments                                        | 5          |
| 8 Approvals & reversals | `server/approvals.ts`, all six reversal paths                                                         | 6, 7       |
| 9 Reports & analytics   | `server/reports.ts`, `server/analytics.ts`, exports                                                   | 6, 7, 8    |
| Phase 6 utilities       | `backup-engine.ts` → `pg_dump`/PITR, `restore.ts`, `check.ts` parity, **SQLite→PostgreSQL data copy** | 9          |
| Phase 8 SaaS            | `platform_accounts`, `plans`, `subscriptions`, `subscription_events`, `platform_admins`               | 9          |

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
- **Phase 7 naming.** Invitation-based staff provisioning already shipped (commit `f9272ee`) as
  `user_invites` + `/api/invites`, with hashed tokens, 7-day expiry, per-branch limits, duplicate
  email revocation and super-admin-only admin invitations. The plan names the same feature
  `staff_invitations` + `/api/staff/invitations`. The behaviour is implemented; only the names
  differ. Renaming means a migration plus client/API changes — say the word and it will be done as
  its own slice.
