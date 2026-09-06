# Architecture and control boundaries

## Components

- **Client:** React 19, React Router, TypeScript, Vite, self-hosted Inter/Manrope, Lucide icons and embedded SVG charts. No external CDN is required. Tables/forms have loading/error/empty states; modal focus is trapped. Mobile administration and desktop/tablet POS were browser-tested.
- **API:** Express, Zod, better-sqlite3, PDFKit. Browser calls are relative `/api` requests; the Vite proxy is development-only. Production serves the compiled client directly.
- **Database:** one SQLite file with foreign keys, WAL and FULL synchronous mode. The schema includes business/branch/user/role/permission scopes, catalogue masters, barcodes, customers, sessions, sales/items/payments, suppliers, purchases/items/receipts/settlements, expenses/documents, inventory/movements, reconciliations, approval requests/events, linked reversals, journals, audit, price history and environment markers.

## Authentication and permissions

New passwords use salted, versioned scrypt (N=131072, r=8, p=1). Legacy hashes are verified and upgraded after successful authentication; malformed hashes fail closed. Login has rate limiting and per-email lockout. Sessions use opaque random tokens stored hashed in the database, 12-hour expiry, HttpOnly cookies, CSRF tokens, origin checks and password/session revocation.

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

The client keeps business/branch/user-scoped exact-body pending keys and financial request bodies in session storage. A pending financial action blocks a different financial posting until resolved. The existing outcome lookup/cancellation API now covers checkout, expenses, purchases, supplier payments, stock/session entries and approval actions. Legacy body-less keys can be safely cancelled if unposted; successful but malformed JSON confirmations do not erase recovery keys. Unposted cancellation stores an immutable tombstone in the same immediate transaction domain; a delayed identical sale cannot cross that cancellation. Previously uncertain keys survive a failed CSRF/permission retry.

## Main journal semantics

- Opening stock: Dr Inventory / Cr Opening equity.
- Supplier receipt: Dr net Inventory and any explicitly recorded Input VAT / Cr gross Accounts payable.
- Supplier settlement: Dr Accounts payable / Cr tender account.
- Sale: Dr tender accounts / Cr Sales revenue + Output VAT; Dr COGS / Cr Inventory.
- Expense: Dr net expense category and any explicitly recorded Input VAT / Cr gross tender amount.
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

Audit rows contain actor/role/entity/time/before/after/reason/IP/device/approval link and a SHA-256 chain. Integrity checks validate SQLite/FKs, journal balance, inventory movements and the audit chain. Schema versions 2/3 migrate existing field values and child references without rewriting them; schema reconstruction and all guards commit together or roll back. The schema/migrations are in `server/schema.sql`, `server/db.ts` and `server/migrations.ts`; the immutable preview/operational marker is enforced before startup.

## Auren / AI boundary

`GET /api/intelligence/features?from=YYYY-MM-DD&to=YYYY-MM-DD` requires report permission and emits a versioned read-only metrics/product-feature document. It has no model API key and no write capability. An external recommendation service can consume approved features. Any proposed financial change must enter the same human-reviewed workflow, never mutate a ledger autonomously.

## Customer records

`customers` is business-scoped master data with a composite `sales.customer_id` foreign key. The POS attaches a recorded customer to the sale in progress or creates one at the till; a walk-in sale omits `customer_id` entirely, so its request body and durable-key fingerprint are unchanged. `customer_name` is projected into sale reads and snapshotted into `receipt_snapshot_json` beside the merchant, branch and register identity, so a later master-data change cannot rewrite what an old receipt says about who bought the goods. Records are create-and-attach: there is no edit, deactivate, merge or delete path, and **no customer balance, credit limit, statement or receivable ledger exists**. Attaching a customer never defers payment — the sale still requires tenders that exactly match the total.

## Continuous verification

`.github/workflows/ci.yml` runs the automated suite, TypeScript, ESLint, Prettier, the production build, the Cloudflare Pages output guard and `npm audit --omit=dev` on every push and pull request, then runs the real-browser scenarios in a dependent job and uploads both artifacts. The two other workflows in that directory are optional and inert by default: the Azure container template is manual-dispatch only and refuses to run while its placeholder app name is set (ephemeral container-app storage also contradicts the persistent-volume requirement in [DEPLOYMENT.md](DEPLOYMENT.md)), and the SLSA generator attests the compiled `dist/` artifacts it actually builds. CI proves the software chains work; it cannot close the external fiscal, provider, hardware or host gates.

## Threat model and explicit limits

The application protects ordinary and administrator users from unauthorised application-level reads/writes and silent historical changes. The host, deployment administrator and database/file owner are trusted. Someone with filesystem/database-owner access can drop triggers or rewrite both a database and its hash chain; this is not a tamper-proof external ledger. Restricted host access, encrypted/off-site backups and independently anchored hashes are required for stronger assurance.

Files are private, purpose/owner/role scoped and limited to 3 MB with MIME/signature checks, sanitised names and restrictive direct-response CSP. This is not content disarm or malware scanning. Session/login endpoints are rate-limited in one process; use appropriate ingress controls rather than scaling this process horizontally.

Input VAT is a manually entered accounting claim, not verification of deductibility or a filed VAT return. The app records manually verified tenders/refunds. It is not a payment gateway, certified fiscal invoicing system, tax adviser or automated misconduct detector.
