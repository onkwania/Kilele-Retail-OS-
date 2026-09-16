# Kilele Retail OS

A working, production-oriented retail POS and business-management application for a Kenyan wines, spirits and soft-drinks shop. React/TypeScript client, Express API and a transactional SQLite accounting and inventory ledger.

**This is not a visual-only prototype.** The cashier, catalogue, inventory, purchases, expenses, reconciliation, approval, reporting, staff and audit screens use authenticated APIs and persisted records. A separate, permanently marked preview workspace is available for evaluation.

## Audit status

The existing architecture was audited and extended, not rebuilt. See the [third-pass gap audit](docs/GAP_AUDIT.md), the [second-pass audit/final status](docs/SECOND_PASS_AUDIT.md), the [181-row requirement matrix](docs/REQUIREMENTS_MATRIX.md) and [execution evidence](docs/SECOND_PASS_VERIFICATION.json). The suite currently contains **115 automated tests across 21 files and ten real-browser scenarios**, and every push and pull request is verified by [continuous integration](.github/workflows/ci.yml) rather than by manual discipline alone. External fiscal, provider, hardware and host acceptance gates remain open; this is **not an unconditional production go-live declaration**.

## Cloudflare Pages deployment

For the connected Pages project, use **`npm run build:pages` → `dist/client`**, not the repository root. Read [Cloudflare setup and safe API connection](docs/CLOUDFLARE_SETUP.md) before redeploying. The Pages adapter fails closed until an actual Kilele API is configured; it does **not** automatically connect Supabase or replace the existing database.

## Start here

| You want to…                                   | Go to…                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| Try the application without real business data | `npm ci` then `npm run dev`                                                          |
| Configure products and start trading           | [Operating guide](docs/OPERATIONS.md)                                                |
| Deploy a private, HTTPS-protected installation | [Deployment & recovery](docs/DEPLOYMENT.md)                                          |
| Understand permissions and accounting controls | [Architecture & security](docs/ARCHITECTURE.md)                                      |
| Review automated acceptance and limitations    | [Verification record](docs/ACCEPTANCE.md)                                            |
| Inspect the starter catalogue’s evidence       | [Catalogue notes](docs/CATALOGUE.md) / [source register](docs/catalogue-sources.csv) |
| Follow implementation checkpoints              | [Implementation log](docs/IMPLEMENTATION.md)                                         |
| See what CI enforces on every push             | [CI workflow](.github/workflows/ci.yml) / [gap audit](docs/GAP_AUDIT.md)             |

### Preview

```bash
npm ci
npm run dev
```

Open the web service on port **5173**. The API runs on **3001**; browser requests use relative `/api` URLs through the web proxy. Both services bind to `0.0.0.0`.

- Preview authentication is intentionally convenient and **not safe for real business data**.
- If your browser blocks embedded third-party storage, open the preview in its own tab. Production runs first-party behind HTTPS.
- Preview provenance is stored immutably in the database. Changing an environment variable cannot promote that database into production.
- The normal starter database has **140 source-linked listings**, **no selling or buying prices**, **no invented barcodes**, **unset tax treatment**, and **zero stock**. One accessory’s package information remains unconfirmed and must be entered before sale.
- Owner-entered prices are never replaced by a price feed. The sandbox’s actual working catalogue is not populated with the amounts used in tests.
- Do not use a production `.env` when starting preview. The environment guard refuses preview access to operational records.

### Verification

```bash
npm run verify       # automated API/client tests → TypeScript → ESLint → production build
npm run db:check     # read-only checks on the configured existing database
npx playwright install --with-deps chromium
npm run test:e2e     # production client, real browser, isolated in-memory databases
```

The browser suite needs Chromium’s system libraries and `openssl` for local, ephemeral HTTPS certificates. It never uses `data/kilele.sqlite`. Synthetic prices and test credentials are confined to test fixtures and test-driven UI entries.

## Operational capabilities

- Fast SKU/barcode/name/brand search, quantity controls, quotes, authorised discounts, cash with change, M-Pesa/card/bank references and split tenders. A recorded customer may be attached to a sale or created at the till; this is an association only and **never opens a credit account or a customer balance**.
- Snapshot-based receipts as 58 mm, 80 mm or A4 print-ready PDFs. Durable keys, response-loss recovery and race-safe cancellation of **unposted** financial submissions, including expenses, receiving and approvals.
- Editable catalogue metadata and nullable, versioned, manually maintained buying/retail/wholesale/promo prices; spreadsheet-like bulk pricing and staged CSV/TSV import.
- Opening stock, supplier receiving, moving weighted-average costing, counts, wastage/damage and a before/after movement ledger.
- Supplier credit and actual-reference settlements; independently reviewed receiving replacements; expenses with private evidence; optional manually confirmed recoverable input-VAT amounts; register sessions and reviewed daily closing.
- Independent approval, rejection or clarification. Posted originals stay intact; corrections append linked reversals/adjustments and review events.
- Date-filtered dashboard and financial/operational analytics, plus **10 CSV/PDF reports**: sales, profit, inventory, expenses, purchases, staff, approvals, audit, payments and journal.
- Five server-enforced roles and **single-use invitation links**, so an administrator can appoint a supervisor or an employee who then creates their own account and chooses their own password. Accounts opened directly with a temporary password still require rotation at first sign-in. Private uploads, immutable price/audit histories and ledger-integrity checks throughout.
- Consistent online backups, checksum manifests, fresh-path restore and a read-only recommendations data boundary.

## Important boundaries

This application records manually confirmed payments; it **does not initiate or verify M-Pesa, card or bank transfers**. Refund records likewise require a real, separately confirmed refund. Internal receipts are **not KRA eTIMS fiscal invoices**. Tax treatment, licensing, age-verification practice, cash procedures and business go-live approval need the owner’s and accountant’s review.

The supported deployment is **one application process with a local persistent SQLite volume**. Multi-instance/high-availability hosting, an eTIMS connector, provider integrations, antivirus scanning, off-site backup storage and a formal penetration test are not included. Docker/Caddy templates are supplied; no real cloud deployment has been performed in this workspace.

Do not put real records in the public evaluation preview. Follow the deployment checklist, create a clean operational database and configure your own accounts and values first.
