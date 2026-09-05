# Multi-branch readiness — foundation, not activated operations

The current UI remains intentionally single-branch. It was not rebuilt during this audit.

## Existing foundation

Businesses own branches. Users currently belong to one branch. Sales, purchases, expenses, cash sessions, reconciliations, stock movements and journals carry business/branch scopes. Inventory balances are keyed by business + branch + product. Masters (products, brands, suppliers and customers) are business-scoped. Register names are currently attributes of cash sessions, with case-normalised uniqueness while a register is open.

Scope tests deny cross-tenant/cross-branch detail access, isolate staff projections and prevent replaying a cached mutation after an administrative branch reassignment. Shared product price edits do not rewrite historical sale snapshots or branch WAC inventory.

## Before activation

- Define an authorised business/branch/register provisioning workflow and explicit user memberships/branch permissions. Do not simply expose `branch_id` as an editable request field.
- Define stable register identities/device assignments rather than relying only on session display names.
- Reject branch/role reassignment while cash sessions or unresolved browser submissions need resolution; close/review them in their original branch first.
- Switch authenticated scope explicitly, revalidate access server-side and isolate local drafts/pending intents. New client recovery keys already include business/branch/user; legacy unresolved keys need operator review.
- Decide whether prices stay business-wide or require separately versioned branch overrides. Do not recalculate past sales.
- Implement paired, independently controlled transfer-out/in movements and valuation/journal rules, including in-transit goods and discrepancy review. No transfer endpoint currently exists.
- Add branch reports, consolidated reporting permissions, independent approval coverage and cross-branch negative tests.
- Review invoice/settlement allocation across branches and supplier batch-payment semantics. A real provider transfer must not be silently double allocated.
- Keep one writer instance on a local SQLite volume. Multi-node HA/replication requires a deliberate storage/concurrency design, not multiple containers mounting the same file.

These are **P3 future capabilities** unless the rollout requires multiple branches immediately; in that case they become an explicit deployment gate. No current single-branch acceptance result certifies multi-site operations.
