# Implementation record

## Initial audit — 5 September 2026

- `/home/user` is empty; no Git repository, reusable components, database, auth, RBAC, or design system.
- No existing conflicts or migrations. Node 20 and Python 3.13 are available.
- Stack: React + TypeScript + Vite, Express, SQLite/WAL via better-sqlite3, Zod, opaque cookie sessions.
- Design: Kilele, a calm evergreen/ivory business workspace; honest empty financial states.
- Scope: one business/branch in first UI, scoped relational records ready for branch-aware API expansion.

## Execution plan

1. **Architecture + database + RBAC**: schema, constraints, immutable triggers, session auth, permission matrix, integer money, tests.
2. **Catalogue + pricing**: verified Kenyan products, null prices, product CRUD without financial deletion, price histories, bulk editor.
3. **POS**: atomic checkout, cost/price/tax snapshots, split tenders, idempotency, receipts.
4. **Inventory + purchases**: WAC inventory ledger, opening balance, receiving approval, suppliers, stock counts/wastage.
5. **Expenses + closing**: immutable expenses, cash sessions, settlement-aware closing, variance explanations.
6. **Approvals + audit**: independent reviewer, reversals linked to originals, append-only audit chain, clarification.
7. **Dashboard**: real-date analytics, category/product/staff performance, empty states.
8. **Reports**: scoped filters, CSV/PDF, receipts, journal and audit exports.
9. **Hardening**: CSRF/origin checks, session rotation, rate limits, upload validation, uniqueness, security review.
10. **Acceptance**: API and browser E2E tests, production build, integrity checks, operations handoff.

Each phase gets tests, typecheck, lint, build, integrity and permission review before being labelled complete. Test fixtures may contain synthetic amounts; the actual application seed NEVER contains prices, opening stock, or financial transactions.

## Deployment boundary

The sandbox preview is an explicitly isolated, non-production workspace. Production startup must reject preview mode. Real deployment requires TLS, independently provisioned users, protected/persisted database storage, backups and recovery verification, operational review, and tax/payment integration decisions. This is not a claim of certified KRA/eTIMS integration.

## Historical backend checkpoints

The “pending” notes below describe those checkpoints, not the final state. Frontend integration and acceptance are recorded after them.

- Phase 1 backend foundation verified: 7 automated tests; typecheck, lint, production build and SQLite integrity review passed. Tables are business/branch scoped; role matrix reviewed. No financial seed data. Browser auth and staff UI will be exercised during integration.
- Phase 2 backend verified: 10 tests at checkpoint; sourced catalogue with all prices null; versioned bulk price endpoint, immutable price history, metadata/barcode workflows and permission review passed. Frontend bulk sheet remains integration work.
- Phase 3 backend verified: 16 tests at checkpoint; exact quotes, split tenders, change, cost/tax snapshots, receipt PDF, stock-ledger trigger, balanced journal and idempotent checkout. Build/type/lint/integrity passed. Added a database guard requiring a price-history entry before price changes. POS UI and browser acceptance remain integration work.
- Phase 4 backend verified: 20 tests at checkpoint. Audited suppliers; immutable purchases; staff receiving held pending; admin posting; supplier settlements; once-only opening stock; WAC valuation; stale-count rejection; full stock ledger. Typecheck/lint/build/integrity and permissions passed.
- Phase 5 backend verified: 23 tests at checkpoint. Immutable expenses, exact register cash formula (with supplier cash payments separately deducted), closing snapshots, variance reasons and permanently closed sessions. Posting timestamps determine cash impact; receipt dates remain separately available. Typecheck/lint/build/integrity passed. UI and browser checks pending.
- Phase 6 backend verified: 29 tests at checkpoint. Independent review, reject/clarify/reply, partial sale returns, full sale voids, expense reversal/replacement, supplier/purchase reversals, price/supplier approval, stock corrections, closing approval and append-only closing corrections. Original financial records preserved. Refunds use the approving user's live register, never reopen historical sessions. Typecheck/lint/build/integrity passed.
- Phase 7 backend verified: recorded-cost analytics, return-aware revenue/profit, today/yesterday/week/month comparisons, product/category/brand/staff/tender trends, inventory movement and a read-only intelligence feature boundary. No fabricated financial charts. Checkpoint: 32 tests; type/lint/build/integrity passed after fixing typed aggregation results.
- Phase 8 backend verified: ten report types, applicable server-side filters, exact tender report, historical inventory valuation, CSV formula protection, PDF exports and audited downloads. Checkpoint: 35 tests; type/lint/build/integrity passed.
- Phase 9 backend hardening in progress: safe staff provisioning/reset, temporary-password rotation, report overrides, image/PDF signature validation, scoped document access and audited settings. Checkpoint: 37 tests. Frontend and full browser/security regression work remains.

## Integrated frontend and hardening checkpoint

All screens are now mounted, routed and API-connected: dashboard, POS, sales, products, pricing, inventory, purchases, expenses, daily closing, approvals, reports, staff, audit, settings and login/password rotation. Shared controls support loading/error/empty states and responsive layouts; fonts are self-hosted. Read-only browser navigation found no runtime page errors.

Integration fixes included cashier readiness without exposing costs, effective closing-count projections, required correction narratives, inspection of supplier-payment originals, correct posting-date refund collections, honest chart units/legends, and accessible small-text/contrast adjustments.

The critical response-loss path was strengthened with actor-scoped durable checkout intents, preserved keys after unreadable responses/auth failures, committed-result recovery, changed-cart blocking, and an atomic cancellation tombstone. Five client tests and authenticated race/replay API tests cover these rules. Immediate action guards prevent repeated click handlers.

Environment provenance prevents preview promotion and operational preview login. Embedded previews use secure partitioned cookies; real HTTPS iframe browser tests exposed limitations in mocked cookie forwarding, so acceptance uses actual local TLS. Receipt/evidence actions fetch within the authenticated partition and download in an embedded preview. Production retains Strict cookies and forbids embedding.

Additional hardening covers integer SQLite guards, cross-tenant/RBAC checks, private upload signatures/limits, required narratives and clarification ownership, WAC purchase returns, payment-reversal session attribution, historical receipt content, backup/restore verification and read-only integrity checks. The sourced catalogue now includes 140 entries and an idempotent, explicitly attributed extension command; unconfirmed accessory package information is left blank.

## Phase 10 browser acceptance and handoff

Five production-client Chromium scenarios passed: the full financial journey; navigation/tablet/mobile layout; genuine cross-site HTTPS preview cookies and documents; restricted cashier selling; and production HTTPS/password authentication with preview disabled. Synthetic amounts are entered only inside disposable acceptance fixtures; the main preview's prices and stock are not populated by these tests.

Compiled bootstrap/check/backup/restore commands passed a fresh-path round-trip. Runtime bundles include the operational CLIs. Single-instance Docker/Caddy deployment templates, operating/security/recovery guides and a row-level catalogue source register are supplied. Code is formatted for maintenance.

Final verification output and the current limitations are recorded in `docs/ACCEPTANCE.md`. These checks do not establish an external security audit, tax certification, hardware acceptance, cloud deployment or configured off-site recovery. Production requires the owner-led checklist in `docs/DEPLOYMENT.md`.

Final checkpoint: 2026-09-05 13:10:35 UTC. All 55 tests, five real-browser scenarios, typecheck, lint, build, format check, database integrity and runtime dependency audit passed. A final filesystem review found and corrected overly broad default SQLite file modes: application database/WAL/SHM files are now owner-only, with a dedicated regression test. No real prices, stock or financial entries were inserted into the main preview. Remaining deployment/business boundaries are explicit in the acceptance and deployment guides.

## Second-pass audit — existing implementation retained

Starting from `1731254`, the complete source/configuration/test tree was re-inventoried and every requested baseline command executed successfully (55 tests, five browser scenarios). Reproduced gaps were classified before implementation. The second pass extends the same engines and closes the owned code/control gaps described in `SECOND_PASS_AUDIT.md`; it does not introduce a replacement POS architecture.

The expanded suite contains 86 tests across 18 files and eight browser scenarios, including accountant HTTP operations/denials, old-schema preservation/failed-upgrade rollback, exact VAT/zero-cent allocations, non-POS unknown outcomes, real receipt identity/layouts, barcode/XSS behaviour, branch/provenance attacks, and backup publication/copy races. Lint findings in newly added test imports were fixed and the complete verify chain re-run. See `SECOND_PASS_VERIFICATION.json` for actual command outcomes rather than treating this note as proof.

The public evaluation data remains unpriced/unstocked; no synthetic financial fixtures were copied into it. Fiscal/provider integration and physical/site/off-site recovery acceptance remain explicit external P1 gates. The current recommendation is conditional software acceptance, not unconditional production go-live.
