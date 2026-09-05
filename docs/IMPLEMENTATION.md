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

## Phase records
- Phase 1 backend foundation verified: 7 automated tests; typecheck, lint, production build and SQLite integrity review passed. Tables are business/branch scoped; role matrix reviewed. No financial seed data. Browser auth and staff UI will be exercised during integration.
- Phase 2 backend verified: 10 tests at checkpoint; sourced catalogue with all prices null; versioned bulk price endpoint, immutable price history, metadata/barcode workflows and permission review passed. Frontend bulk sheet remains integration work.
- Phase 3 backend verified: 16 tests at checkpoint; exact quotes, split tenders, change, cost/tax snapshots, receipt PDF, stock-ledger trigger, balanced journal and idempotent checkout. Build/type/lint/integrity passed. Added a database guard requiring a price-history entry before price changes. POS UI and browser acceptance remain integration work.
