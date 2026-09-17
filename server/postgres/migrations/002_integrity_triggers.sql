-- Kilele Retail OS - PostgreSQL financial integrity triggers
--
-- A faithful port of every guard the SQLite ledger enforces. Sources of truth:
--   * server/schema.sql lines 296-317 and 349-353 (inventory, approvals, cash sessions,
--     invitations, duplicate supplier invoices)
--   * server/db.ts createDb() lines 69-91 (immutable tables, movement ledger, price history)
-- Exception messages are reproduced verbatim because the API returns them to users and the
-- test suite asserts on them.
--
-- Port rules applied:
-- * SQLite `IS NOT` (null-safe inequality) -> `IS DISTINCT FROM`; `IS` -> `IS NOT DISTINCT FROM`.
-- * `json_extract(col,'$.k')` -> `col::jsonb ->> 'k'`. A missing key yields SQL NULL in both
--   dialects, so the null-safe comparison behaves identically.
-- * `rowid` ordering -> the explicit `seq` IDENTITY columns added in 001.
-- * Triggers whose SQLite WHEN clause contains a subquery move that test into the function
--   body: PostgreSQL does not allow subqueries in a trigger WHEN expression.
-- * The immutable guards keep SQLite's naming (one trigger per operation,
--   `immutable_<table>_update` / `immutable_<table>_delete`) so an integrity check written
--   against either engine looks for the same objects.
--
-- Deliberately NOT ported:
-- * db.ts's `integer_<table>_<op>` typeof() guards ("Integer minor units and quantities are
--   required"). They exist because SQLite is dynamically typed and will happily store the
--   string '1500' in an INTEGER column. PostgreSQL rejects that at the type level, so the
--   guards are unreachable. Money stays BIGINT everywhere (see 001 and integrity.ts).
-- * `PRAGMA recursive_triggers = ON` was needed so INSERT OR REPLACE could not evade the
--   DELETE guards. PostgreSQL has no REPLACE statement and query.ts rejects the SQLite
--   spellings, so there is nothing to evade.
--
-- Run after 001_initial_schema.sql. Idempotent.

-- ---------------------------------------------------------------------------
-- 1. Immutable financial records (server/db.ts `immutable` list, verbatim order)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t TEXT;
  op TEXT;
  immutable_tables TEXT[] := ARRAY[
    'environment_markers',
    'purchase_reversals',
    'supplier_refunds',
    'supplier_payment_reversals',
    'reconciliation_adjustments',
    'sales',
    'sale_items',
    'payments',
    'expenses',
    'expense_reversals',
    'sale_reversals',
    'sale_return_items',
    'purchases',
    'purchase_items',
    'purchase_receipts',
    'supplier_payments',
    'inventory_movements',
    'reconciliations',
    'documents',
    'journal_entries',
    'journal_lines',
    'audit_logs',
    'price_history',
    'approval_events',
    'idempotency_keys'
  ];
BEGIN
  FOREACH t IN ARRAY immutable_tables LOOP
    -- Inside format(), `%%` produces the single `%` placeholder that RAISE needs at run time.
    EXECUTE format($f$
      CREATE OR REPLACE FUNCTION immutable_%1$s_guard() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION '%% records are immutable; request a correction', TG_TABLE_NAME;
      END;
      $fn$;
    $f$, t);
    FOREACH op IN ARRAY ARRAY['UPDATE', 'DELETE'] LOOP
      EXECUTE format('DROP TRIGGER IF EXISTS immutable_%s_%s ON %I', t, lower(op), t);
      EXECUTE format(
        'CREATE TRIGGER immutable_%s_%s BEFORE %s ON %I FOR EACH ROW EXECUTE FUNCTION immutable_%s_guard()',
        t, lower(op), op, t, t
      );
    END LOOP;
  END LOOP;
END $$;

-- Note on the message: SQLite interpolates the table name at trigger-creation time, so the
-- text is e.g. "sales records are immutable; request a correction". TG_TABLE_NAME reproduces
-- that exactly, and it is unqualified because the trigger is bound to one table.

-- ---------------------------------------------------------------------------
-- 2. Inventory is a projection of the movement ledger only
-- ---------------------------------------------------------------------------

-- schema.sql:299 - an opening balance must be posted as a ledger movement.
CREATE OR REPLACE FUNCTION inventory_initial_zero() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Opening inventory must use a ledger movement';
END; $$;

DROP TRIGGER IF EXISTS inventory_initial_zero ON inventory;
CREATE TRIGGER inventory_initial_zero
BEFORE INSERT ON inventory
FOR EACH ROW
WHEN (NEW.quantity <> 0 OR NEW.value_cents <> 0)
EXECUTE FUNCTION inventory_initial_zero();

-- schema.sql:301
CREATE OR REPLACE FUNCTION inventory_cannot_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Inventory cannot be deleted';
END; $$;

DROP TRIGGER IF EXISTS inventory_cannot_delete ON inventory;
CREATE TRIGGER inventory_cannot_delete
BEFORE DELETE ON inventory
FOR EACH ROW EXECUTE FUNCTION inventory_cannot_delete();

-- schema.sql:296 - the only permitted writer is movement_updates_inventory below. An UPDATE
-- is accepted solely when the newest movement for that position already records exactly this
-- transition, so a hand-written `UPDATE inventory SET quantity=...` is always rejected.
CREATE OR REPLACE FUNCTION inventory_only_from_ledger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM inventory_movements m
    WHERE m.business_id = NEW.business_id AND m.branch_id = NEW.branch_id AND m.product_id = NEW.product_id
      AND m.previous_qty = OLD.quantity AND m.new_qty = NEW.quantity
      AND m.previous_value_cents = OLD.value_cents AND m.new_value_cents = NEW.value_cents
      AND m.seq = (SELECT MAX(seq) FROM inventory_movements
                   WHERE business_id = NEW.business_id AND branch_id = NEW.branch_id AND product_id = NEW.product_id)
  ) THEN
    RAISE EXCEPTION 'Inventory updates require a matching ledger movement';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS inventory_only_from_ledger ON inventory;
CREATE TRIGGER inventory_only_from_ledger
BEFORE UPDATE ON inventory
FOR EACH ROW EXECUTE FUNCTION inventory_only_from_ledger();

-- db.ts:75 - compare-and-swap: a movement is only accepted against the live position it
-- claims to follow, so two concurrent writers cannot both post the same delta.
CREATE OR REPLACE FUNCTION movement_matches_inventory() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM inventory i
    WHERE i.business_id = NEW.business_id AND i.branch_id = NEW.branch_id AND i.product_id = NEW.product_id
      AND i.quantity = NEW.previous_qty AND i.value_cents = NEW.previous_value_cents
  ) THEN
    RAISE EXCEPTION 'Stock changed; reload before posting';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS movement_matches_inventory ON inventory_movements;
CREATE TRIGGER movement_matches_inventory
BEFORE INSERT ON inventory_movements
FOR EACH ROW EXECUTE FUNCTION movement_matches_inventory();

-- db.ts:78 - ...and the ledger row then projects itself onto the position.
CREATE OR REPLACE FUNCTION movement_updates_inventory() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE inventory SET quantity = NEW.new_qty, value_cents = NEW.new_value_cents, version = version + 1
  WHERE business_id = NEW.business_id AND branch_id = NEW.branch_id AND product_id = NEW.product_id;
  RETURN NULL;
END; $$;

DROP TRIGGER IF EXISTS movement_updates_inventory ON inventory_movements;
CREATE TRIGGER movement_updates_inventory
AFTER INSERT ON inventory_movements
FOR EACH ROW EXECUTE FUNCTION movement_updates_inventory();

-- ---------------------------------------------------------------------------
-- 3. Approvals preserve the original request (schema.sql:302-307)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION approval_preserve_original() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Original approval requests are immutable';
END; $$;

DROP TRIGGER IF EXISTS approval_preserve_original ON approval_requests;
CREATE TRIGGER approval_preserve_original
BEFORE UPDATE ON approval_requests
FOR EACH ROW
WHEN (
  NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.kind <> OLD.kind OR
  NEW.entity_id <> OLD.entity_id OR NEW.payload_json <> OLD.payload_json OR
  NEW.original_json <> OLD.original_json OR NEW.reason <> OLD.reason OR
  NEW.business_id <> OLD.business_id OR NEW.branch_id <> OLD.branch_id OR
  NEW.explanation <> OLD.explanation OR NEW.requested_change <> OLD.requested_change OR
  NEW.created_at <> OLD.created_at OR NEW.entity <> OLD.entity OR
  NEW.evidence_id IS DISTINCT FROM OLD.evidence_id
)
EXECUTE FUNCTION approval_preserve_original();

-- Only the review fields (status, reviewer_id, review_reason, reviewed_at) are writable, and
-- only until a decision exists.
CREATE OR REPLACE FUNCTION approval_no_terminal_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A reviewed request cannot be changed';
END; $$;

DROP TRIGGER IF EXISTS approval_no_terminal_update ON approval_requests;
CREATE TRIGGER approval_no_terminal_update
BEFORE UPDATE ON approval_requests
FOR EACH ROW
WHEN (OLD.status IN ('approved', 'rejected'))
EXECUTE FUNCTION approval_no_terminal_update();

CREATE OR REPLACE FUNCTION approval_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Approval history cannot be deleted';
END; $$;

DROP TRIGGER IF EXISTS approval_no_delete ON approval_requests;
CREATE TRIGGER approval_no_delete
BEFORE DELETE ON approval_requests
FOR EACH ROW EXECUTE FUNCTION approval_no_delete();

-- ---------------------------------------------------------------------------
-- 4. Cash sessions (schema.sql:308-311)
-- ---------------------------------------------------------------------------
-- The only allowed update is closing a live session: everything identifying the session is
-- frozen, closed_at must go from NULL to a value, and an already-closed session is immutable.
CREATE OR REPLACE FUNCTION cash_session_preserve() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Only closing a live session is allowed';
END; $$;

DROP TRIGGER IF EXISTS cash_session_preserve ON cash_sessions;
CREATE TRIGGER cash_session_preserve
BEFORE UPDATE ON cash_sessions
FOR EACH ROW
WHEN (
  OLD.closed_at IS NOT NULL OR NEW.id <> OLD.id OR NEW.business_id <> OLD.business_id OR
  NEW.branch_id <> OLD.branch_id OR NEW.user_id <> OLD.user_id OR NEW.register <> OLD.register OR
  NEW.opening_cents <> OLD.opening_cents OR NEW.opened_at <> OLD.opened_at OR NEW.closed_at IS NULL
)
EXECUTE FUNCTION cash_session_preserve();

CREATE OR REPLACE FUNCTION cash_session_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Sessions cannot be deleted';
END; $$;

DROP TRIGGER IF EXISTS cash_session_no_delete ON cash_sessions;
CREATE TRIGGER cash_session_no_delete
BEFORE DELETE ON cash_sessions
FOR EACH ROW EXECUTE FUNCTION cash_session_no_delete();

-- ---------------------------------------------------------------------------
-- 5. Staff invitations (schema.sql:312-317)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION invite_preserve_terms() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Invitation terms are immutable; revoke and invite again';
END; $$;

DROP TRIGGER IF EXISTS invite_preserve_terms ON user_invites;
CREATE TRIGGER invite_preserve_terms
BEFORE UPDATE ON user_invites
FOR EACH ROW
WHEN (
  NEW.id <> OLD.id OR NEW.business_id <> OLD.business_id OR NEW.branch_id <> OLD.branch_id OR
  NEW.name <> OLD.name OR NEW.email <> OLD.email OR NEW.role_id <> OLD.role_id OR
  NEW.token_hash <> OLD.token_hash OR NEW.invited_by <> OLD.invited_by OR
  NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at OR
  NEW.reason <> OLD.reason OR NEW.reports_access IS DISTINCT FROM OLD.reports_access
)
EXECUTE FUNCTION invite_preserve_terms();

-- Writable while pending: status, closed_at, closed_reason, accepted_user_id.
CREATE OR REPLACE FUNCTION invite_no_terminal_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A closed invitation cannot change state';
END; $$;

DROP TRIGGER IF EXISTS invite_no_terminal_update ON user_invites;
CREATE TRIGGER invite_no_terminal_update
BEFORE UPDATE ON user_invites
FOR EACH ROW
WHEN (OLD.status <> 'pending')
EXECUTE FUNCTION invite_no_terminal_update();

CREATE OR REPLACE FUNCTION invite_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Invitations cannot be deleted';
END; $$;

DROP TRIGGER IF EXISTS invite_no_delete ON user_invites;
CREATE TRIGGER invite_no_delete
BEFORE DELETE ON user_invites
FOR EACH ROW EXECUTE FUNCTION invite_no_delete();

-- ---------------------------------------------------------------------------
-- 6. One active purchase per supplier invoice (schema.sql:349)
-- ---------------------------------------------------------------------------
-- "Active" = received and not reversed, or not yet received and not rejected by an approval
-- decision. A rejected or fully reversed invoice may be entered again.
CREATE OR REPLACE FUNCTION active_purchase_invoice() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM purchases p
    WHERE p.business_id = NEW.business_id AND p.supplier_id = NEW.supplier_id
      AND lower(trim(p.invoice_ref)) = lower(trim(NEW.invoice_ref))
      AND (
        (EXISTS (SELECT 1 FROM purchase_receipts pr WHERE pr.purchase_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM purchase_reversals rv WHERE rv.purchase_id = p.id))
        OR
        (NOT EXISTS (SELECT 1 FROM purchase_receipts pr WHERE pr.purchase_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM approval_requests r
                         WHERE r.entity_id = p.id AND r.kind = 'stock_receipt' AND r.status = 'rejected'))
      )
  ) THEN
    RAISE EXCEPTION 'This supplier invoice already has an active purchase';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS active_purchase_invoice ON purchases;
CREATE TRIGGER active_purchase_invoice
BEFORE INSERT ON purchases
FOR EACH ROW EXECUTE FUNCTION active_purchase_invoice();

-- ---------------------------------------------------------------------------
-- 7. A price change requires matching immutable price history (db.ts:81)
-- ---------------------------------------------------------------------------
-- The newest history row for the product must record exactly this before/after state for all
-- six pricing fields; otherwise the update is rejected.
CREATE OR REPLACE FUNCTION product_price_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (
    NEW.cost_cents IS DISTINCT FROM OLD.cost_cents OR NEW.selling_cents IS DISTINCT FROM OLD.selling_cents OR
    NEW.wholesale_cents IS DISTINCT FROM OLD.wholesale_cents OR NEW.promo_cents IS DISTINCT FROM OLD.promo_cents OR
    NEW.tax_mode <> OLD.tax_mode OR NEW.tax_bps <> OLD.tax_bps
  ) AND NOT EXISTS (
    SELECT 1 FROM price_history h
    WHERE h.product_id = OLD.id
      AND (h.previous_json::jsonb ->> 'cost_cents')::bigint      IS NOT DISTINCT FROM OLD.cost_cents
      AND (h.next_json::jsonb     ->> 'cost_cents')::bigint      IS NOT DISTINCT FROM NEW.cost_cents
      AND (h.previous_json::jsonb ->> 'selling_cents')::bigint   IS NOT DISTINCT FROM OLD.selling_cents
      AND (h.next_json::jsonb     ->> 'selling_cents')::bigint   IS NOT DISTINCT FROM NEW.selling_cents
      AND (h.previous_json::jsonb ->> 'wholesale_cents')::bigint IS NOT DISTINCT FROM OLD.wholesale_cents
      AND (h.next_json::jsonb     ->> 'wholesale_cents')::bigint IS NOT DISTINCT FROM NEW.wholesale_cents
      AND (h.previous_json::jsonb ->> 'promo_cents')::bigint     IS NOT DISTINCT FROM OLD.promo_cents
      AND (h.next_json::jsonb     ->> 'promo_cents')::bigint     IS NOT DISTINCT FROM NEW.promo_cents
      AND (h.previous_json::jsonb ->> 'tax_mode')                IS NOT DISTINCT FROM OLD.tax_mode
      AND (h.next_json::jsonb     ->> 'tax_mode')                IS NOT DISTINCT FROM NEW.tax_mode
      AND (h.previous_json::jsonb ->> 'tax_bps')::bigint         IS NOT DISTINCT FROM OLD.tax_bps
      AND (h.next_json::jsonb     ->> 'tax_bps')::bigint         IS NOT DISTINCT FROM NEW.tax_bps
      AND h.seq = (SELECT MAX(seq) FROM price_history WHERE product_id = OLD.id)
  ) THEN
    RAISE EXCEPTION 'Price changes require a matching immutable price history';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS product_price_guard ON products;
CREATE TRIGGER product_price_guard
BEFORE UPDATE ON products
FOR EACH ROW EXECUTE FUNCTION product_price_guard();

-- ---------------------------------------------------------------------------
-- 8. Protections that live in the application, not in triggers
-- ---------------------------------------------------------------------------
-- * Reversal and refund arithmetic limits ("Sale return exceeds its original quantity...")
--   stay in server/core.ts: they produce user-facing messages and depend on rounding rules
--   shared with the receipt printer. The rows they validate are immutable once written.
-- * `SELECT ... FOR UPDATE` row locking for the stock engine is provided by
--   server/postgres/transaction.ts (lockInventory), not by a trigger.
-- * The audit hash chain is written by server/core.ts audit() and verified by
--   server/postgres/check.ts; audit_logs is additionally immutable at the database level.
