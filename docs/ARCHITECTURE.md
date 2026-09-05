# Architecture and control boundaries

## Components

- **Client:** React 19, React Router, TypeScript, Vite, self-hosted Inter/Manrope, Lucide icons and embedded SVG charts. No external CDN is required. Tables/forms have loading/error/empty states; modal focus is trapped. Mobile administration and desktop/tablet POS were browser-tested.
- **API:** Express, Zod, better-sqlite3, PDFKit. Browser calls are relative `/api` requests; the Vite proxy is development-only. Production serves the compiled client directly.
- **Database:** one SQLite file with foreign keys, WAL and FULL synchronous mode. The schema includes business/branch/user/role/permission scopes, catalogue masters, barcodes, customers, sessions, sales/items/payments, suppliers, purchases/items/receipts/settlements, expenses/documents, inventory/movements, reconciliations, approval requests/events, linked reversals, journals, audit, price history and environment markers.

## Authentication and permissions

Passwords use salted scrypt. Login has rate limiting and per-email lockout. Sessions use opaque random tokens stored hashed in the database, 12-hour expiry, HttpOnly cookies, CSRF tokens, origin checks and password/session revocation.

| Role             | Principal scope                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| Super Admin      | Full business operations; alone may create/manage administrator accounts                                |
| Administrator    | Operations, products/prices, settings, reporting and independent review; may manage non-admin staff     |
| Staff Accountant | Sales, expenses, supplier receiving, stock requests, closing, permitted reports and correction requests |
| Cashier          | Own-session POS, own sales/receipts/closing, catalogue without buying costs, own requests               |
| Inventory Staff  | Catalogue, stock, receiving, supplier view, stock requests and inventory/purchase reports               |

Every route and mutation enforces server-side permissions and business/branch scope. Accountants cannot manage staff, settings, audit or prices directly. Their financial-report permission can be explicitly disabled. No role can approve its own request. New staff must change temporary passwords. Changing access revokes existing sessions, including a current self-edit session.

The current client is a single-branch workspace. Cross-tenant and role-denial tests protect the branch-ready architecture; they are not a claim of delivered multi-tenant provisioning UI or multi-site HA.

## Exact financial and inventory posting

Money is validated as decimal strings and converted to integer KES cents. Rounding uses BigInt half-up arithmetic. Quantities and monetary integers are guarded at both application and SQLite-trigger levels.

Mutations run inside immediate database transactions. Durable keys are scoped to the actor and fingerprint the method, route and body. A committed result replays once; a changed body with the same key is rejected. Financial rows, inventory movements, journal rows, prices and audit events are append-only. Inventory balance changes must match a movement; price changes must match a price-history entry.

Checkout records historical package/name/price/tax/discount/weighted-average-cost snapshots, payment references/change, stock movements and balanced journals. Later product edits do not recalculate those values. Buying costs are omitted from cashier DTOs; `cost_configured` is a non-sensitive readiness flag.

The client keeps actor-scoped exact-body pending keys in session storage. Checkout additionally preserves its original body, blocks a different sale until resolved, and exposes committed-result lookup. Unposted cancellation stores an immutable tombstone in the same immediate transaction domain; a delayed identical sale cannot cross that cancellation. Previously uncertain keys survive a failed CSRF/permission retry.

## Main journal semantics

- Opening stock: Dr Inventory / Cr Opening equity.
- Supplier receipt: Dr Inventory / Cr Accounts payable.
- Supplier settlement: Dr Accounts payable / Cr tender account.
- Sale: Dr tender accounts / Cr Sales revenue + Output VAT; Dr COGS / Cr Inventory.
- Expense: Dr expense category / Cr tender account.
- Sale return: reverse the recorded cumulative price/tax/COGS and append refund/restock entries.
- Purchase return: unwind payable and net settlements, remove stock at current WAC, and explicitly journal valuation differences.
- Stock count/loss: append inventory and inventory-adjustment counterpart entries.
- Reviewed cash variance: append over/short entry; subsequent count corrections journal only the variance delta.

Original closing snapshots are never rewritten by later refunds or corrections. Session totals follow the session where cash actually moves. Expense receipt dates and accounting posting dates are distinct.

## Corrections and review

Requests preserve original JSON, reason, explanation, requested outcome, exact execution payload and optional evidence. The request payload and original cannot be changed. Clarifications append events; final decisions are immutable. Review and execution are atomic, independent, reasoned and timestamped. Stale counts/master-data requests fail closed.

No universal “edit historical transaction” endpoint exists. Sale/expense/purchase/payment/stock/closing corrections have explicit execution rules; “other” requests are notes only. No normal financial or inventory delete controls exist.

## Reports and analytics

`/api/dashboard`, `/api/analytics/staff` and `/api/reports/:type` read recorded ledger events. Refunds and reversals appear on their posting dates, with original-sales attribution where appropriate. Inventory history reconstructs movement balances. Reports reject unsupported filters, avoid split-payment line multiplication, limit projections and audit exports. CSV defends against spreadsheet formulas; PDF is paginated.

Audit rows contain actor/role/entity/time/before/after/reason/IP/device/approval link and a SHA-256 chain. Integrity checks validate SQLite/FKs, journal balance, inventory movements and the audit chain. The initial schema and migrations are in `server/schema.sql` / `server/db.ts`; the immutable preview/operational marker is enforced before startup.

## Auren / AI boundary

`GET /api/intelligence/features?from=YYYY-MM-DD&to=YYYY-MM-DD` requires report permission and emits a versioned read-only metrics/product-feature document. It has no model API key and no write capability. An external recommendation service can consume approved features. Any proposed financial change must enter the same human-reviewed workflow, never mutate a ledger autonomously.

## Threat model and explicit limits

The application protects ordinary and administrator users from unauthorised application-level reads/writes and silent historical changes. The host, deployment administrator and database/file owner are trusted. Someone with filesystem/database-owner access can drop triggers or rewrite both a database and its hash chain; this is not a tamper-proof external ledger. Restricted host access, encrypted/off-site backups and independently anchored hashes are required for stronger assurance.

Files are private, purpose/owner/role scoped and limited to 3 MB with MIME/signature checks, sanitised names and restrictive direct-response CSP. This is not content disarm or malware scanning. Session/login endpoints are rate-limited in one process; use appropriate ingress controls rather than scaling this process horizontally.

The app records manually verified tenders/refunds. It is not a payment gateway, certified fiscal invoicing system, tax adviser or automated misconduct detector.
