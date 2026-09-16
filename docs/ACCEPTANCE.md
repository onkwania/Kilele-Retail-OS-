# First-pass verification record — 5 September 2026

**Historical checkpoint.** The current second-pass results and remaining production gates are in [SECOND_PASS_AUDIT.md](SECOND_PASS_AUDIT.md) and [SECOND_PASS_VERIFICATION.json](SECOND_PASS_VERIFICATION.json).

## Verified in this workspace

- **55 automated unit/API/client tests**, covering authentication/RBAC, decimal calculations, immutable records, catalogue/manual prices, atomic sales and stock, purchases, expenses, closing, approvals, analytics, reports, management and hardening.
- **Five real Chromium browser scenarios** using the production-built client and disposable in-memory data, including genuine local HTTPS rather than mocked cookie responses.
- TypeScript, ESLint (including hooks rules), Vite/esbuild production build and SQLite/ledger/audit integrity checks.
- Compiled production CLI bootstrap, check, backup and fresh-path restore round-trip.
- Production dependency audit: zero known vulnerabilities at the checked checkpoint. This is not a penetration test or a guarantee about future advisories.

The automated browser scenarios verify:

1. Initially unpriced/unstocked catalogue; manual price entry; witnessed opening stock and register float; cash/change; split cash/M-Pesa; committed checkout with a deliberately lost response and reload recovery; receipt PDF; expense with private evidence; supplier creation/credit receipt/cash settlement; staged two-row CSV price import; preserved stock valuation and old sale prices; second administrator creation/password rotation; pending count and sale-return requests; immutable closing; independent approvals; exact inventory/session/profit outcomes; CSV/PDF export and integrity.
2. All workspace navigation, tablet POS, mobile administration, no runtime page exceptions, and no tested viewport horizontal overflow.
3. Actual cross-site HTTPS iframe authentication with Secure/SameSite=None/Partitioned preview cookies, plus authenticated receipt/evidence downloads.
4. Restricted cashier login/rotation, hidden buying costs/stock value, functioning configured-product checkout, own-sales scope and denied administrative navigation.
5. Production-mode HTTPS login, unavailable preview endpoint, Secure/HttpOnly/SameSite=Strict cookie and unpriced/zero-stock operational startup.

Additional automated hardening covers cross-tenant access denial, accountant report overrides, file signatures/access/purpose/size, integer database guards, owner-only database/WAL permissions, required correction narratives, clarification ownership, stale approvals, WAC purchase-return differences, supplier-payment reversal drawer attribution, historical refund dates, receipt content, backup checksums and immutable preview provenance. Client tests preserve keys after unreadable/failed responses, reject changed uncertain carts, isolate actors and block checkout when durable storage is unavailable.

## What was not claimed

- No real customer payments, inventory or prices were used for acceptance. The visible main preview remains an evaluation workspace with prices unset and zero stock unless the user explicitly configures it.
- No KRA eTIMS connector, payment-provider connection, offline selling, multi-instance deployment or automatic AI posting is provided.
- No external penetration test, antivirus service, real TLS/DNS/cloud deployment, actual POS-printer/scanner hardware test, off-site backup installation or business/tax sign-off has been performed here.
- The Docker/Caddy template is supplied for deployment review; the verified application build and local HTTPS tests do not establish that an arbitrary production host is configured correctly.
- File/database owners remain trusted. In-app append-only controls are not protection against a hostile host administrator.

## Reproduce

```bash
npm ci
npm run verify
npm run db:check
npx playwright install --with-deps chromium
npm run test:e2e
npm audit --omit=dev
```

Browser output and failure traces are generated under `test-results/` and `playwright-report/` (ignored, not business records). Keep successful test output with each release. Run the deployment checklist and a restore drill again on the actual target host before live use.

## Final checkpoint

Final chained verification completed at **2026-09-05 13:10:35 UTC / 16:10:35 EAT**: 55 tests across 11 files, five browser scenarios, typecheck, lint, production build, formatting and runtime dependency audit all passed. The main preview's integrity check passed with 16 audit events, and its database/WAL permissions were 0600. The production client was 462.88 kB JavaScript (133.43 kB gzip) and 79.24 kB CSS (16.42 kB gzip), with self-hosted fonts.

The immediately preceding data inspection confirmed 140 products, zero configured buying/selling prices, zero stock, and no sales, expenses or purchases in the main preview. CLI backup/restore round-trips used separate test databases; test financial entries were never copied into the evaluation workspace.

## Checkpoint — 16 September 2026 (invitation-based staff provisioning)

The figures above are the 5 September record and are left exactly as written. Re-executed in this workspace on 2026-09-16 after adding staff invitations:

- `npm run test` — **115 tests across 21 files**, all passing (includes the new `tests/invites.test.ts`, 9 cases).
- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`, `npm run check:pages` — all exit 0.
- `npm run db:check` — `{"ok": true, "errors": []}` against the running preview database.
- `npm audit --omit=dev` — **0 vulnerabilities**; no runtime dependency was added.
- Production client: **497.25 kB JavaScript (143.37 kB gzip)** and **84.87 kB CSS (17.58 kB gzip)**, self-hosted fonts. The 462.88 kB / 79.24 kB figures above belong to the earlier checkpoint.

The invitation flow was also driven over HTTP against the live preview workspace: an invitation was issued, previewed anonymously, redeemed anonymously, replayed (refused `410`), and the resulting account then signed in normally with the password its holder chose. The preview database retains that demonstration account.

`npm run test:e2e` — now **ten** real-browser scenarios, the newest covering invite → accept → denied administrator escalation → withdraw → dead link — was **not executed in this sandbox**, because Chromium cannot be downloaded here. It is executed by [CI](../.github/workflows/ci.yml) on every push and pull request. Nothing in this checkpoint closes E01 (KRA eTIMS/fiscal), E02 (real payment-provider settlement) or E03 (hardware, host/TLS rollout, off-site backup and witnessed restore drill), and no email-delivery capability is claimed: Kilele still does not send mail.

## Checkpoint — 16 September 2026 (PostgreSQL data layer, schema and financial protections)

The figures above are earlier records and are left exactly as written. Executed in this workspace on
**2026-09-16 21:40 UTC / 17 September 00:40 EAT** after adding the PostgreSQL migration work
(Phases 1–4 of the migration plan):

- `npm run test` — **132 tests across 22 files passing, 1 file (39 tests) skipped** because
  `DATABASE_URL` was not set. The skipped file is the PostgreSQL suite; it skips loudly on stderr
  rather than reporting success.
- `DATABASE_URL=… npm run db:pg:test` — **39 tests passing against a real PostgreSQL 18.4 server**
  started in this sandbox (`@embedded-postgres`, installed with `--no-save`; it is not a project
  dependency). The server's own log records each guard firing with the expected message.
- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`, `npm run check:pages`
  — all exit 0. The production client is unchanged at **497.25 kB JavaScript (143.37 kB gzip)** and
  **84.87 kB CSS (17.58 kB gzip)**; this work adds no browser code.
- `npm audit --omit=dev` — **0 vulnerabilities**. One runtime dependency was added: `pg`
  (plus `@types/pg` for development). `better-sqlite3` is still installed and still the default.
- `npm run db:check` — `{"ok": true, "errors": [], "auditEvents": 5}` against the running preview
  database. The SQLite ledger and the preview workspace were **not** modified by this work.

Verified against a virgin PostgreSQL database, in this order: `db:pg:ping`; `db:pg:migrate`
(three files applied); `db:pg:migrate` again (`"applied": []`, three skipped); editing an applied
migration and re-running, which **exited 1** with _"Applied migrations must never be edited"_;
`db:pg:protections` → `ok: true` with **65 triggers, 114 indexes, 105 foreign keys, 47 tables**;
`db:pg:test` → 39 passing; `db:pg:bootstrap` → workspace created, and a second run created nothing;
`db:pg:check` → `{"ok": true, "errors": []}` with the audit hash chain verified.

What this checkpoint does **not** claim:

- **The API cannot run on PostgreSQL yet.** `DATABASE_ENGINE=postgres` makes every entrypoint fail
  at startup by design, because the ~20 Express modules still use the synchronous SQLite helpers.
  Converting them (Slices 1–9 of the plan) is the remaining majority of the work and is tracked in
  [docs/POSTGRES_MIGRATION.md](POSTGRES_MIGRATION.md). Nothing was cut over and no deployment
  changed.
- **No data was migrated.** There is no SQLite→PostgreSQL copy tool; `server/backup-engine.ts` and
  `server/restore.ts` remain SQLite-only. A PostgreSQL deployment today bootstraps an empty
  workspace.
- **No Supabase or Render resource was created or configured.** That requires credentials this
  workspace does not have, and none were requested.
- `integrity()` on PostgreSQL states its own coverage: six of the SQLite `integrity()` checks
  (purchase header/items, expense reversals, closing snapshot arithmetic, approval reviewer
  metadata, the ledger-to-account-map recomputation, supplier payment/refund reconciliation) are
  listed in its `checks.pending` output as not yet ported.
- This checkpoint closes none of E01 (KRA eTIMS/fiscal), E02 (real payment-provider settlement) or
  E03 (hardware, host/TLS rollout, off-site backup and witnessed restore drill).
- The plan asked for this work on a branch named `feature/postgres-supabase-migration`. This session
  is pinned to `arena/01a0754f-kilele-retail-os` and cannot create or push another branch; the work
  is committed here and reaches `main` through the existing pull request.
