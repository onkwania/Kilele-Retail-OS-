# Third-pass gap audit — 6 September 2026

A read-only audit of the repository as checked out at `75ddfc0`, followed by closure of the gaps that
are owned by this codebase. This pass **extends** the existing implementation; it does not replace the
POS, ledger, inventory, approval, reporting or recovery architecture audited in
[SECOND_PASS_AUDIT.md](SECOND_PASS_AUDIT.md).

## Method

1. **Read-only first.** Full file inventory, source review of every server module, client page and
   deployment file, cross-checking of documentation claims against the code rather than against other
   documentation, and a search for unfinished markers (`TODO`, `FIXME`, stubs, placeholders).
2. **Establish real state, not claimed state.** Installed dependencies, then executed the project's own
   commands: `npm run test`, `npm run typecheck`, `npm run lint`, `npm run format:check`,
   `npm run build`, `npm run check:pages`, `npm audit --omit=dev`.
3. **Smoke-tested the running system.** Booted the preview workspace (API on `3001`, web on `5173`) and
   exercised it over HTTP: health, anonymous and preview authentication, catalogue, integrity, all ten
   report types, and the Vite `/api` proxy.
4. **Reconciled every client call against every server route**, and every server capability against the
   UI that is supposed to reach it.
5. Only then changed code, and re-ran the same commands.

### Environment caveat — read this before treating the numbers as full acceptance

This sandbox could not download prebuilt binaries (`release-assets.githubusercontent.com` and
`nodejs.org` are unreachable), so `better-sqlite3` was compiled locally from source against the
container's Node headers, and **Playwright Chromium could not be installed**. Consequences:

- The automated API/unit/client suite, TypeScript, ESLint, Prettier, the production build, the Pages
  output guard and the runtime dependency audit **were executed here and all passed**.
- The real-browser suite **was not executed here**. Its scenario count below is a static reading of
  `e2e/workspace.spec.ts`. It now runs in CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)),
  which is the first time this repository has had any automated pipeline at all.
- `npm run db:check` was not run against a business database; there is none in this workspace. Integrity
  was instead verified through the authenticated `/api/integrity` endpoint and inside the test suite.

This is **not** an unconditional production go-live declaration. The external gates E01 (KRA eTIMS /
fiscal), E02 (real payment-provider settlement) and E03 (physical hardware, host/TLS rollout, off-site
backup and witnessed restore drill) are unchanged and remain open.

## What was verified sound and deliberately left alone

No unfinished markers exist anywhere in the source. The following were checked and needed no change:
five-role RBAC with per-user overrides; opaque hashed sessions, CSRF, origin checks and lockouts;
immutable preview/operational provenance; append-only financial rows with recursive `REPLACE` guards;
integer-money and BigInt half-up rounding; the movement-ledger/WAC inventory engine; scoped integrity
reconciliation; ten report types (all reachable and returning 200 over authenticated HTTP); the
fail-closed Cloudflare Pages adapter; unique-staging/no-clobber backup publication; transactional schema
migration; and the durable submission recovery path. Zero runtime dependency advisories.

## Findings and closure

| ID  | Sev | Gap found by reading, then reproduced                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Closure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Evidence                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | P0  | **The repository had no CI at all.** `.github/workflows/` contained only two unmodified GitHub templates: an Azure container deploy that fired on every push to `main`, published an image to ghcr.io and then tried to deploy to an app literally named `your-app-name` with a secret that does not exist (a guaranteed red run on every commit, and an unintended public image); and an SLSA generator that signed level-3 provenance over `echo "artifact1" > artifact1` dummy files on every release. Meanwhile every acceptance document rests on "the commands were run manually". | Added [`ci.yml`](../.github/workflows/ci.yml): install → test → typecheck → lint → format → build → Pages output guard → `npm audit --omit=dev`, plus a dependent browser job that installs Chromium and runs the real scenarios, uploading both artifacts. Azure template made `workflow_dispatch`-only with a guard that refuses to run while the placeholder app name is set, and a header explaining that ephemeral container-app storage contradicts the single-process/local-SQLite-volume requirement in [DEPLOYMENT.md](DEPLOYMENT.md). SLSA generator now compiles the real artifacts and attests their digests instead of dummies. | All three workflows parse as valid YAML with the intended triggers. Every command the CI runs was executed locally first and exits 0, so the pipeline is not born red.                                                                                                                                                                                                                                |
| G2  | P1  | **The UI invented a business address.** `Layout.tsx` rendered `'Nairobi, Kenya'` whenever `branches.location` was empty. Bootstrap deliberately stores `''` with the comment _"Owner supplies the actual branch location; do not infer an address"_, and receipts correctly say `Not configured` / `Not recorded`. The live preview confirmed `location: ''`, so every fresh installation displayed a fabricated address for the shop.                                                                                                                                                   | Replaced with an honest `Branch location not set`. The real value is entered in **Settings → Business identity → Branch location**, which already persisted and audited it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Preview API returns `"location": ""`; the sidebar now shows the unset state instead of a city nobody entered.                                                                                                                                                                                                                                                                                         |
| G3  | P1  | **Customer master data was a dead capability.** `customers` table, composite `sales.customer_id` foreign key, `scoped()` validation in `createSale`, and `GET`/`POST /api/customers` were all implemented — with no client surface, no read projection, no receipt line and zero tests. The POS rendered a hardcoded `Walk-in customer` and never sent `customer_id`; `GET /api/sales` returned the raw id with no name, so even an API-created attachment was invisible.                                                                                                                | POS cart header is now a real button opening a searchable customer picker with inline creation; the choice is sent as `customer_id` and **omitted entirely for walk-in sales so an unattached checkout keeps its exact body and durable-key fingerprint**. `customer_name` is projected into `GET /api/sales` and `GET /api/sales/:id`, snapshotted into `receipt_snapshot_json` alongside the merchant identity, printed as `Sold to:` only when present, and shown/searchable in the Sales list and detail. Added `tests/customers.test.ts` (5 cases).                                                                                     | 106/106 automated tests pass. Cross-tenant attachment returns 404 and posts nothing; a role without `sales.create` is denied the list; one creation per durable key with a changed body rejected 409. **Walk-in receipts proven unchanged**: the same fixture rendered through the pre-change and post-change trees produced identical media boxes and identical extracted text in all three layouts. |
| G4  | P2  | **Documentation drift.** README, the implementation log and the requirement matrix state in the present tense that the suite contains "86 automated tests / 18 files / eight browser scenarios". The executed suite is **106 tests across 20 files**; `e2e/workspace.spec.ts` contains **nine** scenarios. Anyone using those numbers to confirm they had the right checkout would draw the wrong conclusion.                                                                                                                                                                            | README now states the current counts and links this audit. The second-pass records were **annotated, not rewritten** — they remain accurate as a dated checkpoint. A dated third-pass entry was appended to [IMPLEMENTATION.md](IMPLEMENTATION.md).                                                                                                                                                                                                                                                                                                                                                                                          | Test/file counts taken from an executed `npm run test` run; scenario count from a static reading of the spec, flagged as not executed here.                                                                                                                                                                                                                                                           |
| G5  | P3  | **Layout defect found while closing G3.** `.cart-customer > span { flex: 1 }` also matched the `Badge` (which renders a `<span>`), so the pill was stretched to half the cart width, and a customer name longer than "Walk-in customer" could push the row into horizontal overflow at 390 px.                                                                                                                                                                                                                                                                                           | Scoped the flex/ellipsis rule to a `cart-customer-name` class and pinned the badge to `flex: 0 0 auto`; picker rows and identities truncate with ellipsis and a `min-width: 0`.                                                                                                                                                                                                                                                                                                                                                                                                                                                              | The mobile-overflow browser scenario remains the authority for this; it is now wired into CI.                                                                                                                                                                                                                                                                                                         |

## Deliberate scope boundaries added by this pass

- **Attaching a customer is not credit.** No customer balance, statement, credit limit or receivable
  ledger was created, and none exists. Kilele records a manually confirmed payment; the picker only
  associates a name with a sale that has already been paid. This is stated in the picker itself.
- **Customers are create-and-attach only.** There is still no edit, deactivate, merge or delete endpoint
  and no dedicated customer administration page — consistent with the append-only posture of the rest of
  the ledger. The POS picker is the searchable list (capped at 2,000 by the existing endpoint). Adding
  correction workflow for master data would be a separate, reviewed change.
- **No multi-branch UI was activated**, and `MULTI_BRANCH_READINESS.md` remains the reference.

## Reproduce

```bash
npm ci
npm run test          # 106 tests / 20 files
npm run typecheck
npm run lint
npm run format:check
npm run build
npm run check:pages
npm audit --omit=dev
npx playwright install --with-deps chromium
npm run test:e2e      # nine real-browser scenarios
```

If `better-sqlite3` cannot fetch a prebuilt binary in your environment, build it against local Node
headers instead of skipping it: `npm ci --ignore-scripts` then
`node-gyp rebuild --release --nodedir=/usr/local` inside `node_modules/better-sqlite3`.

## Conclusion

Five gaps were found and closed: one P0 in delivery infrastructure, two P1 in product honesty and
completeness, one P2 in documentation accuracy and one P3 layout defect. The software critical chains
still work end to end and are now protected by an automated pipeline instead of manual discipline. The
external P1 gates E01–E03 are **not** closed by this pass and nothing here should be read as fiscal,
provider, hardware or host acceptance.
