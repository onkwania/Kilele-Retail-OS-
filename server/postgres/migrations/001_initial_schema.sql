-- 001_initial_schema.sql — Kilele Retail OS on PostgreSQL
--
-- A faithful conversion of server/schema.sql (SQLite). It is deliberately conservative: the first
-- PostgreSQL version changes the STORAGE ENGINE, not the data model. Deliberate preservations, so that
-- application code and every existing assertion keep their meaning:
--
--   * string identifiers, integer KES cents, ISO-8601 UTC text timestamps, integer 0/1 flags;
--   * *_json columns stay TEXT (the application calls JSON.parse on them; JSONB would hand back an
--     already-parsed object and silently break every read). JSONB is a later, separate migration;
--   * documents.content BLOB -> BYTEA, the only type that had no PostgreSQL equivalent.
--
-- Required conversions (SQLite has no analogue, or the analogue does not exist here):
--
--   SQLite                            PostgreSQL
--   ---------------------------------   -------------------------------------------------------------
--   PRAGMA foreign_keys = ON            always enforced; no statement needed
--   PRAGMA journal_mode = WAL           the normal transaction engine; no statement needed
--   PRAGMA synchronous = FULL           server durability configuration, not schema
--   INTEGER (always 64-bit)             BIGINT for money/quantities, INTEGER only for 0/1 flags and
--                                       small bounded counters, so no column silently narrows
--   INTEGER PRIMARY KEY AUTOINCREMENT   BIGINT GENERATED ALWAYS AS IDENTITY
--   COLLATE NOCASE on email             TEXT plus a unique index on LOWER(email) (no citext dependency)
--   rowid ordering                      an explicit seq IDENTITY on inventory_movements and
--                                       price_history, which the two ordering-sensitive triggers use
--   INSERT OR IGNORE                    INSERT ... ON CONFLICT DO NOTHING (application layer)
--   INSERT OR REPLACE                   refused: no silent replacement path exists or is created
--   RAISE(ABORT, 'msg')                 RAISE EXCEPTION 'msg' (see 002_integrity_triggers.sql)
--   integer typeof() guards             unnecessary: the PostgreSQL type system enforces this already
--
-- Table order is the real foreign-key dependency order, NOT the grouping sketched in the migration
-- plan. approval_requests must be created early because inventory_movements, expenses, journal_entries,
-- purchase_receipts, reconciliations' adjustments and all six reversal tables reference it; likewise
-- cash_sessions precedes every table carrying session_id, and sale_reversals precedes payments.
--
-- Migrations run inside one transaction (see server/postgres/migrate.ts): a failure rolls the whole
-- file back rather than leaving a half-created schema.

-- ---------------------------------------------------------------------------
-- Group 1 — platform, provenance and identity
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS environment_markers (
  kind TEXT PRIMARY KEY CHECK (kind IN ('preview', 'operational')),
  created_at TEXT NOT NULL
);

-- Retained for parity with the SQLite schema; the PostgreSQL runner records its own history below.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pg_schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checksum TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'KES' CHECK (currency = 'KES'),
  timezone TEXT NOT NULL DEFAULT 'Africa/Nairobi',
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  tax_pin TEXT NOT NULL DEFAULT '',
  receipt_footer TEXT NOT NULL DEFAULT 'Thank you for shopping with us.',
  variance_threshold_cents BIGINT NOT NULL DEFAULT 0 CHECK (variance_threshold_cents >= 0),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses (id),
  name TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  UNIQUE (id, business_id)
);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id TEXT NOT NULL REFERENCES roles (id),
  permission_id TEXT NOT NULL REFERENCES permissions (id),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses (id),
  branch_id TEXT NOT NULL,
  role_id TEXT NOT NULL REFERENCES roles (id),
  name TEXT NOT NULL,
  -- Case-insensitive uniqueness is enforced by users_email_ci_unique in 003_indexes.sql.
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (branch_id, business_id) REFERENCES branches (id, business_id),
  UNIQUE (id, business_id, branch_id)
);

CREATE TABLE IF NOT EXISTS user_permissions (
  user_id TEXT NOT NULL REFERENCES users (id),
  permission_id TEXT NOT NULL REFERENCES permissions (id),
  allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
  PRIMARY KEY (user_id, permission_id)
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS login_attempts (
  email TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at TEXT NOT NULL
);

-- Staff invitations. The bearer token is never stored, only its SHA-256 hash. An invitation is a
-- pending promise: the users row is created when it is accepted.
CREATE TABLE IF NOT EXISTS user_invites (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses (id),
  branch_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  role_id TEXT NOT NULL REFERENCES roles (id),
  reports_access INTEGER CHECK (reports_access IN (0, 1)),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  invited_by TEXT NOT NULL REFERENCES users (id),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  closed_at TEXT,
  closed_reason TEXT NOT NULL DEFAULT '',
  accepted_user_id TEXT REFERENCES users (id),
  FOREIGN KEY (branch_id, business_id) REFERENCES branches (id, business_id),
  UNIQUE (id, business_id, branch_id)
);

-- ---------------------------------------------------------------------------
-- Group 2 — catalogue
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses (id),
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#527762',
  UNIQUE (business_id, name),
  UNIQUE (id, business_id)
);

CREATE TABLE IF NOT EXISTS brands (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses (id),
  name TEXT NOT NULL,
  UNIQUE (business_id, name),
  UNIQUE (id, business_id)
);

CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses (id),
  name TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  account_ref TEXT NOT NULL DEFAULT '',
  payment_terms TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (id, business_id)
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses (id),
  name TEXT NOT NULL,
  brand_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  subcategory TEXT NOT NULL DEFAULT '',
  sku TEXT NOT NULL,
  size TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT 'bottle',
  supplier_id TEXT,
  cost_cents BIGINT CHECK (cost_cents >= 0),
  selling_cents BIGINT CHECK (selling_cents > 0),
  wholesale_cents BIGINT CHECK (wholesale_cents > 0),
  promo_cents BIGINT CHECK (promo_cents > 0),
  min_stock BIGINT NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  reorder_level BIGINT NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  tax_bps INTEGER NOT NULL DEFAULT 0 CHECK (tax_bps >= 0 AND tax_bps <= 10000),
  tax_mode TEXT NOT NULL DEFAULT 'unset' CHECK (tax_mode IN ('unset', 'none', 'inclusive', 'exclusive')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  image TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  UNIQUE (business_id, sku),
  UNIQUE (id, business_id),
  FOREIGN KEY (brand_id, business_id) REFERENCES brands (id, business_id),
  FOREIGN KEY (category_id, business_id) REFERENCES categories (id, business_id),
  FOREIGN KEY (supplier_id, business_id) REFERENCES suppliers (id, business_id)
);

CREATE TABLE IF NOT EXISTS product_barcodes (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses (id),
  product_id TEXT NOT NULL,
  barcode TEXT NOT NULL,
  UNIQUE (business_id, barcode),
  FOREIGN KEY (product_id, business_id) REFERENCES products (id, business_id)
);

CREATE TABLE IF NOT EXISTS price_history (
  id TEXT PRIMARY KEY,
  -- Replaces SQLite's rowid as the authoritative insertion order used by product_price_guard.
  seq BIGINT GENERATED ALWAYS AS IDENTITY,
  business_id TEXT NOT NULL REFERENCES businesses (id),
  product_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id),
  previous_json TEXT NOT NULL,
  next_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  approval_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (product_id, business_id) REFERENCES products (id, business_id)
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses (id),
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (id, business_id)
);

-- ---------------------------------------------------------------------------
-- Group 3 — approvals (created early: eleven later tables reference it)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  business_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id),
  kind TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  explanation TEXT NOT NULL DEFAULT '',
  requested_change TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL,
  original_json TEXT NOT NULL DEFAULT '{}',
  evidence_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'clarification', 'approved', 'rejected')),
  reviewer_id TEXT REFERENCES users (id),
  review_reason TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  FOREIGN KEY (branch_id, business_id) REFERENCES branches (id, business_id),
  CHECK (reviewer_id IS NULL OR reviewer_id <> user_id)
);

CREATE TABLE IF NOT EXISTS approval_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES approval_requests (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Group 4 — inventory and registers
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS inventory (
  business_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  quantity BIGINT NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  value_cents BIGINT NOT NULL DEFAULT 0 CHECK (value_cents >= 0),
  version BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (business_id, branch_id, product_id),
  FOREIGN KEY (product_id, business_id) REFERENCES products (id, business_id),
  FOREIGN KEY (branch_id, business_id) REFERENCES branches (id, business_id),
  CHECK (quantity > 0 OR value_cents = 0)
);

CREATE TABLE IF NOT EXISTS cash_sessions (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id),
  register TEXT NOT NULL,
  opening_cents BIGINT NOT NULL CHECK (opening_cents >= 0),
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  FOREIGN KEY (branch_id, business_id) REFERENCES branches (id, business_id),
  UNIQUE (id, business_id, branch_id)
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id TEXT PRIMARY KEY,
  -- Replaces SQLite's rowid as the authoritative insertion order used by the
  -- inventory_only_from_ledger trigger. Never written by the application.
  seq BIGINT GENERATED ALWAYS AS IDENTITY,
  business_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id),
  session_id TEXT,
  kind TEXT NOT NULL,
  quantity BIGINT NOT NULL CHECK (quantity <> 0),
  previous_qty BIGINT NOT NULL CHECK (previous_qty >= 0),
  new_qty BIGINT NOT NULL CHECK (new_qty >= 0),
  value_delta_cents BIGINT NOT NULL,
  previous_value_cents BIGINT NOT NULL,
  new_value_cents BIGINT NOT NULL CHECK (new_value_cents >= 0),
  reason TEXT NOT NULL,
  reference TEXT NOT NULL,
  approval_id TEXT REFERENCES approval_requests (id),
  approval_status TEXT NOT NULL CHECK (approval_status IN ('authorised', 'approved')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (product_id, business_id) REFERENCES products (id, business_id),
  FOREIGN KEY (branch_id, business_id) REFERENCES branches (id, business_id),
  FOREIGN KEY (session_id, business_id, branch_id) REFERENCES cash_sessions (id, business_id, branch_id),
  CHECK (new_qty = previous_qty + quantity),
  CHECK (new_value_cents = previous_value_cents + value_delta_cents),
  CHECK (new_qty > 0 OR new_value_cents = 0)
);

-- ---------------------------------------------------------------------------
-- Group 5 — sales, purchases and expenses
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  business_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id),
  session_id TEXT NOT NULL,
  customer_id TEXT,
  subtotal_cents BIGINT NOT NULL CHECK (subtotal_cents > 0),
  discount_cents BIGINT NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  total_cents BIGINT NOT NULL CHECK (total_cents > 0),
  tax_cents BIGINT NOT NULL CHECK (tax_cents >= 0),
  cogs_cents BIGINT NOT NULL CHECK (cogs_cents >= 0),
  discount_reason TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  receipt_snapshot_json TEXT,
  age_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (age_confirmed IN (0, 1)),
  FOREIGN KEY (session_id, business_id, branch_id) REFERENCES cash_sessions (id, business_id, branch_id),
  FOREIGN KEY (customer_id, business_id) REFERENCES customers (id, business_id),
  UNIQUE (id, business_id, branch_id),
  CHECK (total_cents = subtotal_cents - discount_cents)
);

CREATE TABLE IF NOT EXISTS sale_items (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL,
  business_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  sku TEXT NOT NULL,
  brand_name TEXT NOT NULL,
  category_name TEXT NOT NULL,
  supplier_name TEXT NOT NULL DEFAULT '',
  size TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  quantity BIGINT NOT NULL CHECK (quantity > 0),
  unit_price_cents BIGINT NOT NULL CHECK (unit_price_cents > 0),
  unit_cost_cents BIGINT NOT NULL CHECK (unit_cost_cents >= 0),
  price_type TEXT NOT NULL,
  subtotal_cents BIGINT NOT NULL CHECK (subtotal_cents > 0),
  discount_cents BIGINT NOT NULL CHECK (discount_cents >= 0),
  total_cents BIGINT NOT NULL CHECK (total_cents > 0),
  tax_cents BIGINT NOT NULL CHECK (tax_cents >= 0),
  tax_bps INTEGER NOT NULL,
  tax_mode TEXT NOT NULL,
  cogs_cents BIGINT NOT NULL CHECK (cogs_cents >= 0),
  FOREIGN KEY (sale_id, business_id, branch_id) REFERENCES sales (id, business_id, branch_id),
  FOREIGN KEY (product_id, business_id) REFERENCES products (id, business_id),
  UNIQUE (sale_id, product_id)
);

CREATE TABLE IF NOT EXISTS sale_reversals (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  business_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  sale_id TEXT NOT NULL,
  approval_id TEXT NOT NULL UNIQUE REFERENCES approval_requests (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  session_id TEXT,
  total_cents BIGINT NOT NULL CHECK (total_cents >= 0),
  tax_cents BIGINT NOT NULL,
  cogs_cents BIGINT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (sale_id, business_id, branch_id) REFERENCES sales (id, business_id, branch_id),
  FOREIGN KEY (session_id, business_id, branch_id) REFERENCES cash_sessions (id, business_id, branch_id),
  UNIQUE (id, business_id, branch_id)
);

CREATE TABLE IF NOT EXISTS sale_return_items (
  id TEXT PRIMARY KEY,
  reversal_id TEXT NOT NULL REFERENCES sale_reversals (id),
  sale_item_id TEXT NOT NULL REFERENCES sale_items (id),
  quantity BIGINT NOT NULL CHECK (quantity > 0),
  total_cents BIGINT NOT NULL CHECK (total_cents >= 0),
  tax_cents BIGINT NOT NULL,
  cogs_cents BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  sale_id TEXT NOT NULL,
  reversal_id TEXT,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id),
  method TEXT NOT NULL CHECK (method IN ('Cash', 'M-Pesa', 'Card', 'Bank')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents <> 0),
  tendered_cents BIGINT NOT NULL CHECK (tendered_cents >= 0),
  change_cents BIGINT NOT NULL DEFAULT 0 CHECK (change_cents >= 0),
  reference TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (sale_id, business_id, branch_id) REFERENCES sales (id, business_id, branch_id),
  FOREIGN KEY (reversal_id, business_id, branch_id) REFERENCES sale_reversals (id, business_id, branch_id),
  FOREIGN KEY (session_id, business_id, branch_id) REFERENCES cash_sessions (id, business_id, branch_id),
  CHECK ((reversal_id IS NULL AND amount_cents > 0) OR (reversal_id IS NOT NULL AND amount_cents < 0))
);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  business_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id),
  session_id TEXT,
  category TEXT NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  input_tax_cents BIGINT NOT NULL DEFAULT 0 CHECK (input_tax_cents >= 0 AND input_tax_cents <= amount_cents),
  method TEXT NOT NULL CHECK (method IN ('Cash', 'M-Pesa', 'Card', 'Bank')),
  description TEXT NOT NULL,
  payee TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  document_id TEXT,
  expense_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  replaces_id TEXT REFERENCES expenses (id),
  approval_id TEXT REFERENCES approval_requests (id),
  FOREIGN KEY (branch_id, business_id) REFERENCES branches (id, business_id),
  FOREIGN KEY (session_id, business_id, branch_id) REFERENCES cash_sessions (id, business_id, branch_id),
  UNIQUE (id, business_id, branch_id)
);

CREATE TABLE IF NOT EXISTS expense_reversals (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  business_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  expense_id TEXT NOT NULL UNIQUE,
  approval_id TEXT NOT NULL UNIQUE REFERENCES approval_requests (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  session_id TEXT,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  method TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (expense_id, business_id, branch_id) REFERENCES expenses (id, business_id, branch_id),
  FOREIGN KEY (session_id, business_id, branch_id) REFERENCES cash_sessions (id, business_id, branch_id)
);

CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  business_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id),
  supplier_id TEXT NOT NULL,
  supplier_name TEXT NOT NULL,
  total_cents BIGINT NOT NULL CHECK (total_cents > 0),
  invoice_ref TEXT NOT NULL,
  purchase_date TEXT NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('Credit', 'Cash', 'M-Pesa', 'Card', 'Bank')),
  notes TEXT NOT NULL DEFAULT '',
  document_id TEXT,
  created_at TEXT NOT NULL,
  payment_reference TEXT NOT NULL DEFAULT '',
  replaces_id TEXT,
  input_tax_cents BIGINT NOT NULL DEFAULT 0 CHECK (input_tax_cents >= 0 AND input_tax_cents <= total_cents),
  FOREIGN KEY (replaces_id, business_id, branch_id) REFERENCES purchases (id, business_id, branch_id),
  FOREIGN KEY (supplier_id, business_id) REFERENCES suppliers (id, business_id),
  FOREIGN KEY (branch_id, business_id) REFERENCES branches (id, business_id),
  UNIQUE (id, business_id, branch_id),
  CHECK (replaces_id IS NULL OR replaces_id <> id)
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL,
  business_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  quantity BIGINT NOT NULL CHECK (quantity > 0),
  cost_cents BIGINT NOT NULL CHECK (cost_cents >= 0),
  total_cents BIGINT NOT NULL CHECK (total_cents >= 0),
  FOREIGN KEY (purchase_id, business_id, branch_id) REFERENCES purchases (id, business_id, branch_id),
  FOREIGN KEY (product_id, business_id) REFERENCES products (id, business_id),
  UNIQUE (purchase_id, product_id)
);

CREATE TABLE IF NOT EXISTS purchase_receipts (
  id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL UNIQUE REFERENCES purchases (id),
  approval_id TEXT REFERENCES approval_requests (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS supplier_payments (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  purchase_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id),
  session_id TEXT,
  method TEXT NOT NULL CHECK (method IN ('Cash', 'M-Pesa', 'Card', 'Bank')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  reference TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (purchase_id, business_id, branch_id) REFERENCES purchases (id, business_id, branch_id),
  FOREIGN KEY (session_id, business_id, branch_id) REFERENCES cash_sessions (id, business_id, branch_id)
);

-- ---------------------------------------------------------------------------
-- Group 6 — reversals, refunds and closing
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS purchase_reversals (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  business_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  purchase_id TEXT NOT NULL UNIQUE,
  approval_id TEXT NOT NULL UNIQUE REFERENCES approval_requests (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  total_cents BIGINT NOT NULL,
  inventory_cents BIGINT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (purchase_id, business_id, branch_id) REFERENCES purchases (id, business_id, branch_id)
);

CREATE TABLE IF NOT EXISTS supplier_refunds (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  purchase_id TEXT NOT NULL,
  reversal_id TEXT NOT NULL REFERENCES purchase_reversals (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  session_id TEXT,
  method TEXT NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  created_at TEXT NOT NULL,
  FOREIGN KEY (purchase_id, business_id, branch_id) REFERENCES purchases (id, business_id, branch_id),
  FOREIGN KEY (session_id, business_id, branch_id) REFERENCES cash_sessions (id, business_id, branch_id)
);

CREATE TABLE IF NOT EXISTS supplier_payment_reversals (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  business_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  payment_id TEXT NOT NULL UNIQUE REFERENCES supplier_payments (id),
  purchase_id TEXT NOT NULL REFERENCES purchases (id),
  approval_id TEXT NOT NULL UNIQUE REFERENCES approval_requests (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  session_id TEXT,
  method TEXT NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id, business_id, branch_id) REFERENCES cash_sessions (id, business_id, branch_id)
);

CREATE TABLE IF NOT EXISTS reconciliations (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  business_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users (id),
  opening_cents BIGINT NOT NULL,
  cash_sales_cents BIGINT NOT NULL,
  cash_expenses_cents BIGINT NOT NULL,
  cash_supplier_cents BIGINT NOT NULL,
  expected_cents BIGINT NOT NULL,
  actual_cents BIGINT NOT NULL CHECK (actual_cents >= 0),
  variance_cents BIGINT NOT NULL,
  mpesa_cents BIGINT NOT NULL,
  card_cents BIGINT NOT NULL,
  bank_cents BIGINT NOT NULL,
  explanation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id, business_id, branch_id) REFERENCES cash_sessions (id, business_id, branch_id),
  CHECK (expected_cents = opening_cents + cash_sales_cents - cash_expenses_cents - cash_supplier_cents),
  CHECK (variance_cents = actual_cents - expected_cents)
);

CREATE TABLE IF NOT EXISTS reconciliation_adjustments (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  business_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  reconciliation_id TEXT NOT NULL REFERENCES reconciliations (id),
  approval_id TEXT NOT NULL UNIQUE REFERENCES approval_requests (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  previous_actual_cents BIGINT NOT NULL,
  actual_cents BIGINT NOT NULL CHECK (actual_cents >= 0),
  previous_variance_cents BIGINT NOT NULL,
  variance_cents BIGINT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (branch_id, business_id) REFERENCES branches (id, business_id)
);

-- ---------------------------------------------------------------------------
-- Group 7 — accounting, evidence, audit and read-only intelligence
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id),
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  content BYTEA NOT NULL,
  created_at TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'request',
  FOREIGN KEY (branch_id, business_id) REFERENCES branches (id, business_id)
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id),
  reference TEXT NOT NULL,
  description TEXT NOT NULL,
  approval_id TEXT REFERENCES approval_requests (id),
  created_at TEXT NOT NULL,
  FOREIGN KEY (branch_id, business_id) REFERENCES branches (id, business_id),
  UNIQUE (id, business_id, branch_id)
);

CREATE TABLE IF NOT EXISTS journal_lines (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  business_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  account TEXT NOT NULL,
  debit_cents BIGINT NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  credit_cents BIGINT NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  FOREIGN KEY (entry_id, business_id, branch_id) REFERENCES journal_entries (id, business_id, branch_id),
  CHECK ((debit_cents > 0 AND credit_cents = 0) OR (credit_cents > 0 AND debit_cents = 0))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  business_id TEXT NOT NULL REFERENCES businesses (id),
  branch_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id),
  role TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  approval_id TEXT,
  ip TEXT NOT NULL,
  device TEXT NOT NULL,
  created_at TEXT NOT NULL,
  previous_hash TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  business_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id),
  key TEXT NOT NULL,
  route TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS intelligence_recommendations (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  model_version TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  recommendation_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (branch_id, business_id) REFERENCES branches (id, business_id)
);
