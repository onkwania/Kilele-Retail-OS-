-- Kilele Retail OS - PostgreSQL indexes
--
-- Exactly the indexes declared in server/schema.sql, converted for PostgreSQL, plus four
-- additions that are called out individually below. Nothing else is indexed: adding
-- speculative indexes to a write-heavy ledger costs throughput on every sale.
--
-- Source lines in server/schema.sql:
--   112-113 cash session uniqueness, 176 payment reference uniqueness,
--   283-295 the reporting/lookup index block, 347-348 purchase indexes,
--   355 normalised register name, 22 users.email UNIQUE COLLATE NOCASE.
--
-- Port notes:
-- * `CREATE INDEX IF NOT EXISTS` and partial indexes (`WHERE ...`) carry over unchanged -
--   PostgreSQL supports both natively.
-- * SQLite `COLLATE NOCASE` has no PostgreSQL equivalent. The application already lower-cases
--   every email at its write boundaries (server/auth.ts, server/db.ts, server/invites.ts,
--   server/management.ts), and uniqueness is enforced here on `lower(email)` so the guarantee
--   survives even if a future caller forgets. READ PATHS MUST MATCH: SQLite queries written as
--   `email = ? COLLATE NOCASE` become `lower(email) = lower($1)` in PostgreSQL. `COLLATE NOCASE`
--   is a syntax error in PostgreSQL and server/postgres/query.ts rejects it explicitly.
--
-- Run after 002_integrity_triggers.sql. Idempotent.

-- ---------------------------------------------------------------------------
-- Cash control: one open session per register and per user (schema.sql:112-113, 355)
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS one_open_session_per_register
  ON cash_sessions (business_id, branch_id, register)
  WHERE closed_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS one_open_session_per_user
  ON cash_sessions (user_id)
  WHERE closed_at IS NULL;

-- Register names are matched case- and space-insensitively, so "Till 1" and " till 1 " cannot
-- both be open. `lower(trim(...))` is a valid PostgreSQL index expression.
CREATE UNIQUE INDEX IF NOT EXISTS open_register_name_normalized
  ON cash_sessions (business_id, branch_id, lower(trim(register)))
  WHERE closed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Payments (schema.sql:176)
-- ---------------------------------------------------------------------------
-- A non-cash tender reference may only be used once per business and method, and only while it
-- has not been reversed. Cash has no reference to deduplicate.
CREATE UNIQUE INDEX IF NOT EXISTS unique_payment_ref
  ON payments (business_id, method, reference)
  WHERE reference <> '' AND reversal_id IS NULL AND method <> 'Cash';

-- ---------------------------------------------------------------------------
-- Reporting and lookup indexes (schema.sql:283-295)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_sales_scope_date ON sales (business_id, branch_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sales_staff ON sales (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_items_product ON sale_items (product_id, sale_id);
CREATE INDEX IF NOT EXISTS idx_products_scope ON products (business_id, active, category_id);
CREATE INDEX IF NOT EXISTS idx_movements_product_date ON inventory_movements (business_id, branch_id, product_id, created_at);
CREATE INDEX IF NOT EXISTS idx_approvals_scope ON approval_requests (business_id, branch_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_expenses_scope ON expenses (business_id, branch_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payments_session ON payments (session_id, method);
CREATE INDEX IF NOT EXISTS idx_audit_scope ON audit_logs (business_id, branch_id, created_at);
CREATE INDEX IF NOT EXISTS idx_purchases_scope ON purchases (business_id, branch_id, created_at);
CREATE INDEX IF NOT EXISTS idx_journal_scope ON journal_lines (business_id, branch_id, account);
CREATE INDEX IF NOT EXISTS idx_invites_scope ON user_invites (business_id, branch_id, status, created_at);
-- Converted: `email` was COLLATE NOCASE in SQLite, so the index is built on lower(email).
CREATE INDEX IF NOT EXISTS idx_invites_email ON user_invites (business_id, lower(email), status);

-- ---------------------------------------------------------------------------
-- Purchases (schema.sql:347-348)
-- ---------------------------------------------------------------------------
-- A replacement purchase may only replace one original.
CREATE UNIQUE INDEX IF NOT EXISTS one_purchase_replacement
  ON purchases (replaces_id)
  WHERE replaces_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS purchase_invoice_lookup ON purchases (business_id, supplier_id, invoice_ref);

-- ---------------------------------------------------------------------------
-- ADDITION 1: case-insensitive email uniqueness (replaces schema.sql:22)
-- ---------------------------------------------------------------------------
-- SQLite declared `email TEXT NOT NULL UNIQUE COLLATE NOCASE` on users. A plain UNIQUE in
-- PostgreSQL would let "owner@x.co.ke" and "Owner@x.co.ke" both register, which is a
-- duplicate-account and lockout-bypass risk, so the uniqueness moves to an expression index.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_ci_unique ON users (lower(email));

-- ---------------------------------------------------------------------------
-- ADDITIONS 2-4: trigger support and pricing lookups
-- ---------------------------------------------------------------------------
-- inventory_only_from_ledger runs `SELECT max(seq) ... WHERE business_id/branch_id/product_id`
-- and product_price_guard runs `SELECT max(seq) ... WHERE product_id` on every protected write.
-- idx_movements_product_date and idx_price_history_product_created index created_at, which does
-- not help a max(seq) lookup, so without these the guards would scan the two hottest tables.
CREATE INDEX IF NOT EXISTS idx_inventory_movements_position
  ON inventory_movements (business_id, branch_id, product_id, seq);

-- schema.sql declares no index on price_history at all; the guard needs the newest row per
-- product, and price lookups page by (product_id, created_at) in the pricing UI.
CREATE INDEX IF NOT EXISTS idx_price_history_product_seq ON price_history (product_id, seq);
CREATE INDEX IF NOT EXISTS idx_price_history_product_created ON price_history (product_id, created_at);
