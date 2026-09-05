PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS environment_markers(kind TEXT PRIMARY KEY CHECK(kind IN ('preview','operational')),created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS businesses (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'KES' CHECK(currency='KES'),
 timezone TEXT NOT NULL DEFAULT 'Africa/Nairobi', address TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
 tax_pin TEXT NOT NULL DEFAULT '', receipt_footer TEXT NOT NULL DEFAULT 'Thank you for shopping with us.',
 variance_threshold_cents INTEGER NOT NULL DEFAULT 0 CHECK(variance_threshold_cents>=0),
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS branches (
 id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id), name TEXT NOT NULL,
 location TEXT NOT NULL DEFAULT '', UNIQUE(id,business_id)
);
CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS permissions (id TEXT PRIMARY KEY, description TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS role_permissions (
 role_id TEXT NOT NULL REFERENCES roles(id), permission_id TEXT NOT NULL REFERENCES permissions(id), PRIMARY KEY(role_id,permission_id)
);
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id), branch_id TEXT NOT NULL,
 role_id TEXT NOT NULL REFERENCES roles(id), name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 must_change_password INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
 FOREIGN KEY(branch_id,business_id) REFERENCES branches(id,business_id), UNIQUE(id,business_id,branch_id)
);
CREATE TABLE IF NOT EXISTS user_permissions (
 user_id TEXT NOT NULL REFERENCES users(id), permission_id TEXT NOT NULL REFERENCES permissions(id),
 allowed INTEGER NOT NULL CHECK(allowed IN(0,1)), PRIMARY KEY(user_id,permission_id)
);
CREATE TABLE IF NOT EXISTS auth_sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf_token TEXT NOT NULL,
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL, ip TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS login_attempts (
 email TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0, locked_until TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS categories (
 id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id), name TEXT NOT NULL,
 color TEXT NOT NULL DEFAULT '#527762', UNIQUE(business_id,name), UNIQUE(id,business_id)
);
CREATE TABLE IF NOT EXISTS brands (
 id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id), name TEXT NOT NULL,
 UNIQUE(business_id,name), UNIQUE(id,business_id)
);
CREATE TABLE IF NOT EXISTS suppliers (
 id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id), name TEXT NOT NULL,
 contact TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
 account_ref TEXT NOT NULL DEFAULT '', payment_terms TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)), created_at TEXT NOT NULL, UNIQUE(id,business_id)
);
CREATE TABLE IF NOT EXISTS products (
 id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id), name TEXT NOT NULL, brand_id TEXT NOT NULL,
 category_id TEXT NOT NULL, subcategory TEXT NOT NULL DEFAULT '', sku TEXT NOT NULL,
 size TEXT NOT NULL DEFAULT '', unit TEXT NOT NULL DEFAULT 'bottle', supplier_id TEXT,
 cost_cents INTEGER CHECK(cost_cents>=0), selling_cents INTEGER CHECK(selling_cents>0),
 wholesale_cents INTEGER CHECK(wholesale_cents>0), promo_cents INTEGER CHECK(promo_cents>0),
 min_stock INTEGER NOT NULL DEFAULT 0 CHECK(min_stock>=0), reorder_level INTEGER NOT NULL DEFAULT 0 CHECK(reorder_level>=0),
 tax_bps INTEGER NOT NULL DEFAULT 0 CHECK(tax_bps>=0 AND tax_bps<=10000),
 tax_mode TEXT NOT NULL DEFAULT 'unset' CHECK(tax_mode IN ('unset','none','inclusive','exclusive')),
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)), image TEXT NOT NULL DEFAULT '',
 notes TEXT NOT NULL DEFAULT '', source_url TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1,
 UNIQUE(business_id,sku), UNIQUE(id,business_id),
 FOREIGN KEY(brand_id,business_id) REFERENCES brands(id,business_id),
 FOREIGN KEY(category_id,business_id) REFERENCES categories(id,business_id),
 FOREIGN KEY(supplier_id,business_id) REFERENCES suppliers(id,business_id)
);
CREATE TABLE IF NOT EXISTS product_barcodes (
 id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id), product_id TEXT NOT NULL,
 barcode TEXT NOT NULL, UNIQUE(business_id,barcode), FOREIGN KEY(product_id,business_id) REFERENCES products(id,business_id)
);
CREATE TABLE IF NOT EXISTS price_history (
 id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id), product_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id), previous_json TEXT NOT NULL, next_json TEXT NOT NULL,
 reason TEXT NOT NULL, approval_id TEXT, created_at TEXT NOT NULL,
 FOREIGN KEY(product_id,business_id) REFERENCES products(id,business_id)
);
CREATE TABLE IF NOT EXISTS inventory (
 business_id TEXT NOT NULL, branch_id TEXT NOT NULL, product_id TEXT NOT NULL,
 quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity>=0), value_cents INTEGER NOT NULL DEFAULT 0 CHECK(value_cents>=0),
 version INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(business_id,branch_id,product_id),
 FOREIGN KEY(product_id,business_id) REFERENCES products(id,business_id),
 FOREIGN KEY(branch_id,business_id) REFERENCES branches(id,business_id),
 CHECK(quantity>0 OR value_cents=0)
);
CREATE TABLE IF NOT EXISTS customers (
 id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id), name TEXT NOT NULL,
 phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
 UNIQUE(id,business_id)
);
CREATE TABLE IF NOT EXISTS cash_sessions (
 id TEXT PRIMARY KEY, business_id TEXT NOT NULL, branch_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id), register TEXT NOT NULL,
 opening_cents INTEGER NOT NULL CHECK(opening_cents>=0), opened_at TEXT NOT NULL, closed_at TEXT,
 FOREIGN KEY(branch_id,business_id) REFERENCES branches(id,business_id), UNIQUE(id,business_id,branch_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_session_per_register ON cash_sessions(business_id,branch_id,register) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS one_open_session_per_user ON cash_sessions(user_id) WHERE closed_at IS NULL;
CREATE TABLE IF NOT EXISTS sales (
 id TEXT PRIMARY KEY, ref TEXT NOT NULL UNIQUE, business_id TEXT NOT NULL, branch_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id), session_id TEXT NOT NULL,
 customer_id TEXT, subtotal_cents INTEGER NOT NULL CHECK(subtotal_cents>0), discount_cents INTEGER NOT NULL DEFAULT 0 CHECK(discount_cents>=0),
 total_cents INTEGER NOT NULL CHECK(total_cents>0), tax_cents INTEGER NOT NULL CHECK(tax_cents>=0),
 cogs_cents INTEGER NOT NULL CHECK(cogs_cents>=0), discount_reason TEXT NOT NULL DEFAULT '',
 notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
 FOREIGN KEY(session_id,business_id,branch_id) REFERENCES cash_sessions(id,business_id,branch_id),
 FOREIGN KEY(customer_id,business_id) REFERENCES customers(id,business_id),
 UNIQUE(id,business_id,branch_id), CHECK(total_cents=subtotal_cents-discount_cents)
);
CREATE TABLE IF NOT EXISTS sale_items (
 id TEXT PRIMARY KEY, sale_id TEXT NOT NULL, business_id TEXT NOT NULL, branch_id TEXT NOT NULL,
 product_id TEXT NOT NULL, product_name TEXT NOT NULL, sku TEXT NOT NULL, brand_name TEXT NOT NULL,
 category_name TEXT NOT NULL, supplier_name TEXT NOT NULL DEFAULT '', size TEXT NOT NULL,
 quantity INTEGER NOT NULL CHECK(quantity>0), unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents>0),
 unit_cost_cents INTEGER NOT NULL CHECK(unit_cost_cents>=0), price_type TEXT NOT NULL,
 subtotal_cents INTEGER NOT NULL CHECK(subtotal_cents>0), discount_cents INTEGER NOT NULL CHECK(discount_cents>=0),
 total_cents INTEGER NOT NULL CHECK(total_cents>0), tax_cents INTEGER NOT NULL CHECK(tax_cents>=0),
 tax_bps INTEGER NOT NULL, tax_mode TEXT NOT NULL, cogs_cents INTEGER NOT NULL CHECK(cogs_cents>=0),
 FOREIGN KEY(sale_id,business_id,branch_id) REFERENCES sales(id,business_id,branch_id),
 FOREIGN KEY(product_id,business_id) REFERENCES products(id,business_id), UNIQUE(sale_id,product_id)
);
CREATE TABLE IF NOT EXISTS approval_requests (
 id TEXT PRIMARY KEY, ref TEXT NOT NULL UNIQUE, business_id TEXT NOT NULL, branch_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL,
 reason TEXT NOT NULL, explanation TEXT NOT NULL DEFAULT '', requested_change TEXT NOT NULL DEFAULT '',
 payload_json TEXT NOT NULL, original_json TEXT NOT NULL DEFAULT '{}', evidence_id TEXT,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','clarification','approved','rejected')),
 reviewer_id TEXT REFERENCES users(id), review_reason TEXT, created_at TEXT NOT NULL, reviewed_at TEXT,
 FOREIGN KEY(branch_id,business_id) REFERENCES branches(id,business_id),
 CHECK(reviewer_id IS NULL OR reviewer_id<>user_id)
);
CREATE TABLE IF NOT EXISTS approval_events (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES approval_requests(id), user_id TEXT NOT NULL REFERENCES users(id),
 action TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sale_reversals (
 id TEXT PRIMARY KEY, ref TEXT NOT NULL UNIQUE, business_id TEXT NOT NULL, branch_id TEXT NOT NULL,
 sale_id TEXT NOT NULL, approval_id TEXT NOT NULL UNIQUE REFERENCES approval_requests(id),
 user_id TEXT NOT NULL REFERENCES users(id), session_id TEXT,
 total_cents INTEGER NOT NULL CHECK(total_cents>0), tax_cents INTEGER NOT NULL, cogs_cents INTEGER NOT NULL,
 reason TEXT NOT NULL, created_at TEXT NOT NULL,
 FOREIGN KEY(sale_id,business_id,branch_id) REFERENCES sales(id,business_id,branch_id),
 FOREIGN KEY(session_id,business_id,branch_id) REFERENCES cash_sessions(id,business_id,branch_id), UNIQUE(id,business_id,branch_id)
);
CREATE TABLE IF NOT EXISTS sale_return_items (
 id TEXT PRIMARY KEY, reversal_id TEXT NOT NULL REFERENCES sale_reversals(id), sale_item_id TEXT NOT NULL REFERENCES sale_items(id),
 quantity INTEGER NOT NULL CHECK(quantity>0), total_cents INTEGER NOT NULL CHECK(total_cents>=0),
 tax_cents INTEGER NOT NULL, cogs_cents INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
 id TEXT PRIMARY KEY, business_id TEXT NOT NULL, branch_id TEXT NOT NULL, sale_id TEXT NOT NULL,
 reversal_id TEXT, session_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
 method TEXT NOT NULL CHECK(method IN('Cash','M-Pesa','Card','Bank')),
 amount_cents INTEGER NOT NULL CHECK(amount_cents<>0), tendered_cents INTEGER NOT NULL CHECK(tendered_cents>=0),
 change_cents INTEGER NOT NULL DEFAULT 0 CHECK(change_cents>=0), reference TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
 FOREIGN KEY(sale_id,business_id,branch_id) REFERENCES sales(id,business_id,branch_id),
 FOREIGN KEY(reversal_id,business_id,branch_id) REFERENCES sale_reversals(id,business_id,branch_id),
 FOREIGN KEY(session_id,business_id,branch_id) REFERENCES cash_sessions(id,business_id,branch_id),
 CHECK((reversal_id IS NULL AND amount_cents>0) OR (reversal_id IS NOT NULL AND amount_cents<0))
);
CREATE UNIQUE INDEX IF NOT EXISTS unique_payment_ref ON payments(business_id,method,reference) WHERE reference<>'' AND reversal_id IS NULL AND method<>'Cash';
CREATE TABLE IF NOT EXISTS expenses (
 id TEXT PRIMARY KEY, ref TEXT NOT NULL UNIQUE, business_id TEXT NOT NULL, branch_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id), session_id TEXT,
 category TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 method TEXT NOT NULL CHECK(method IN('Cash','M-Pesa','Card','Bank')), description TEXT NOT NULL,
 payee TEXT NOT NULL DEFAULT '', reference TEXT NOT NULL DEFAULT '', document_id TEXT,
 expense_date TEXT NOT NULL, created_at TEXT NOT NULL, replaces_id TEXT REFERENCES expenses(id), approval_id TEXT REFERENCES approval_requests(id),
 FOREIGN KEY(branch_id,business_id) REFERENCES branches(id,business_id),
 FOREIGN KEY(session_id,business_id,branch_id) REFERENCES cash_sessions(id,business_id,branch_id), UNIQUE(id,business_id,branch_id)
);
CREATE TABLE IF NOT EXISTS expense_reversals (
 id TEXT PRIMARY KEY, ref TEXT NOT NULL UNIQUE, business_id TEXT NOT NULL, branch_id TEXT NOT NULL,
 expense_id TEXT NOT NULL UNIQUE, approval_id TEXT NOT NULL UNIQUE REFERENCES approval_requests(id),
 user_id TEXT NOT NULL REFERENCES users(id), session_id TEXT, amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 method TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
 FOREIGN KEY(expense_id,business_id,branch_id) REFERENCES expenses(id,business_id,branch_id),
 FOREIGN KEY(session_id,business_id,branch_id) REFERENCES cash_sessions(id,business_id,branch_id)
);
CREATE TABLE IF NOT EXISTS purchases (
 id TEXT PRIMARY KEY, ref TEXT NOT NULL UNIQUE, business_id TEXT NOT NULL, branch_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id), supplier_id TEXT NOT NULL, supplier_name TEXT NOT NULL,
 total_cents INTEGER NOT NULL CHECK(total_cents>0), invoice_ref TEXT NOT NULL, purchase_date TEXT NOT NULL,
 payment_method TEXT NOT NULL CHECK(payment_method IN('Credit','Cash','M-Pesa','Card','Bank')),
 notes TEXT NOT NULL DEFAULT '', document_id TEXT, created_at TEXT NOT NULL,
 FOREIGN KEY(supplier_id,business_id) REFERENCES suppliers(id,business_id),
 FOREIGN KEY(branch_id,business_id) REFERENCES branches(id,business_id),
 UNIQUE(business_id,supplier_id,invoice_ref), UNIQUE(id,business_id,branch_id)
);
CREATE TABLE IF NOT EXISTS purchase_items (
 id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL, business_id TEXT NOT NULL, branch_id TEXT NOT NULL,
 product_id TEXT NOT NULL, product_name TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity>0),
 cost_cents INTEGER NOT NULL CHECK(cost_cents>=0), total_cents INTEGER NOT NULL CHECK(total_cents>=0),
 FOREIGN KEY(purchase_id,business_id,branch_id) REFERENCES purchases(id,business_id,branch_id),
 FOREIGN KEY(product_id,business_id) REFERENCES products(id,business_id), UNIQUE(purchase_id,product_id)
);
CREATE TABLE IF NOT EXISTS purchase_receipts (
 id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL UNIQUE REFERENCES purchases(id), approval_id TEXT REFERENCES approval_requests(id),
 user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS supplier_payments (
 id TEXT PRIMARY KEY, business_id TEXT NOT NULL, branch_id TEXT NOT NULL, purchase_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id), session_id TEXT,
 method TEXT NOT NULL CHECK(method IN('Cash','M-Pesa','Card','Bank')), amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 reference TEXT NOT NULL, created_at TEXT NOT NULL,
 FOREIGN KEY(purchase_id,business_id,branch_id) REFERENCES purchases(id,business_id,branch_id),
 FOREIGN KEY(session_id,business_id,branch_id) REFERENCES cash_sessions(id,business_id,branch_id)
);
CREATE TABLE IF NOT EXISTS inventory_movements (
 id TEXT PRIMARY KEY, business_id TEXT NOT NULL, branch_id TEXT NOT NULL, product_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id), session_id TEXT, kind TEXT NOT NULL,
 quantity INTEGER NOT NULL CHECK(quantity<>0), previous_qty INTEGER NOT NULL CHECK(previous_qty>=0), new_qty INTEGER NOT NULL CHECK(new_qty>=0),
 value_delta_cents INTEGER NOT NULL, previous_value_cents INTEGER NOT NULL, new_value_cents INTEGER NOT NULL CHECK(new_value_cents>=0),
 reason TEXT NOT NULL, reference TEXT NOT NULL, approval_id TEXT REFERENCES approval_requests(id),
 approval_status TEXT NOT NULL CHECK(approval_status IN('authorised','approved')), created_at TEXT NOT NULL,
 FOREIGN KEY(product_id,business_id) REFERENCES products(id,business_id),
 FOREIGN KEY(branch_id,business_id) REFERENCES branches(id,business_id),
 FOREIGN KEY(session_id,business_id,branch_id) REFERENCES cash_sessions(id,business_id,branch_id),
 CHECK(new_qty=previous_qty+quantity), CHECK(new_value_cents=previous_value_cents+value_delta_cents),
 CHECK(new_qty>0 OR new_value_cents=0)
);
CREATE TABLE IF NOT EXISTS reconciliations (
 id TEXT PRIMARY KEY, ref TEXT NOT NULL UNIQUE, business_id TEXT NOT NULL, branch_id TEXT NOT NULL,
 session_id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id),
 opening_cents INTEGER NOT NULL, cash_sales_cents INTEGER NOT NULL, cash_expenses_cents INTEGER NOT NULL,
 cash_supplier_cents INTEGER NOT NULL, expected_cents INTEGER NOT NULL, actual_cents INTEGER NOT NULL CHECK(actual_cents>=0),
 variance_cents INTEGER NOT NULL, mpesa_cents INTEGER NOT NULL, card_cents INTEGER NOT NULL, bank_cents INTEGER NOT NULL,
 explanation TEXT NOT NULL, created_at TEXT NOT NULL,
 FOREIGN KEY(session_id,business_id,branch_id) REFERENCES cash_sessions(id,business_id,branch_id),
 CHECK(expected_cents=opening_cents+cash_sales_cents-cash_expenses_cents-cash_supplier_cents),
 CHECK(variance_cents=actual_cents-expected_cents)
);
CREATE TABLE IF NOT EXISTS documents (
 id TEXT PRIMARY KEY, business_id TEXT NOT NULL, branch_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
 name TEXT NOT NULL, mime TEXT NOT NULL, sha256 TEXT NOT NULL, content BLOB NOT NULL, created_at TEXT NOT NULL,
 FOREIGN KEY(branch_id,business_id) REFERENCES branches(id,business_id)
);
CREATE TABLE IF NOT EXISTS journal_entries (
 id TEXT PRIMARY KEY, business_id TEXT NOT NULL, branch_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
 reference TEXT NOT NULL, description TEXT NOT NULL, approval_id TEXT REFERENCES approval_requests(id), created_at TEXT NOT NULL,
 FOREIGN KEY(branch_id,business_id) REFERENCES branches(id,business_id), UNIQUE(id,business_id,branch_id)
);
CREATE TABLE IF NOT EXISTS journal_lines (
 id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, business_id TEXT NOT NULL, branch_id TEXT NOT NULL,
 account TEXT NOT NULL, debit_cents INTEGER NOT NULL DEFAULT 0 CHECK(debit_cents>=0),
 credit_cents INTEGER NOT NULL DEFAULT 0 CHECK(credit_cents>=0),
 FOREIGN KEY(entry_id,business_id,branch_id) REFERENCES journal_entries(id,business_id,branch_id),
 CHECK((debit_cents>0 AND credit_cents=0) OR (credit_cents>0 AND debit_cents=0))
);
CREATE TABLE IF NOT EXISTS audit_logs (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, business_id TEXT NOT NULL REFERENCES businesses(id),
 branch_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL,
 action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL,
 before_json TEXT NOT NULL, after_json TEXT NOT NULL, reason TEXT NOT NULL, approval_id TEXT,
 ip TEXT NOT NULL, device TEXT NOT NULL, created_at TEXT NOT NULL, previous_hash TEXT NOT NULL, hash TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
 business_id TEXT NOT NULL, branch_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
 key TEXT NOT NULL, route TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT NOT NULL,
 created_at TEXT NOT NULL, PRIMARY KEY(user_id,key)
);
CREATE TABLE IF NOT EXISTS intelligence_recommendations (
 id TEXT PRIMARY KEY, business_id TEXT NOT NULL, branch_id TEXT NOT NULL, kind TEXT NOT NULL,
 model_version TEXT NOT NULL, evidence_json TEXT NOT NULL, recommendation_json TEXT NOT NULL,
 created_at TEXT NOT NULL, FOREIGN KEY(branch_id,business_id) REFERENCES branches(id,business_id)
);
CREATE INDEX IF NOT EXISTS idx_sales_scope_date ON sales(business_id,branch_id,created_at);
CREATE INDEX IF NOT EXISTS idx_sales_staff ON sales(user_id,created_at);
CREATE INDEX IF NOT EXISTS idx_items_product ON sale_items(product_id,sale_id);
CREATE INDEX IF NOT EXISTS idx_products_scope ON products(business_id,active,category_id);
CREATE INDEX IF NOT EXISTS idx_movements_product_date ON inventory_movements(business_id,branch_id,product_id,created_at);
CREATE INDEX IF NOT EXISTS idx_approvals_scope ON approval_requests(business_id,branch_id,status,created_at);
CREATE INDEX IF NOT EXISTS idx_expenses_scope ON expenses(business_id,branch_id,created_at);
CREATE INDEX IF NOT EXISTS idx_payments_session ON payments(session_id,method);
CREATE INDEX IF NOT EXISTS idx_audit_scope ON audit_logs(business_id,branch_id,created_at);
CREATE INDEX IF NOT EXISTS idx_purchases_scope ON purchases(business_id,branch_id,created_at);
CREATE INDEX IF NOT EXISTS idx_journal_scope ON journal_lines(business_id,branch_id,account);
CREATE TRIGGER IF NOT EXISTS inventory_only_from_ledger BEFORE UPDATE ON inventory
WHEN NOT EXISTS (SELECT 1 FROM inventory_movements m WHERE m.business_id=NEW.business_id AND m.branch_id=NEW.branch_id AND m.product_id=NEW.product_id AND m.previous_qty=OLD.quantity AND m.new_qty=NEW.quantity AND m.previous_value_cents=OLD.value_cents AND m.new_value_cents=NEW.value_cents AND m.rowid=(SELECT MAX(rowid) FROM inventory_movements WHERE business_id=NEW.business_id AND branch_id=NEW.branch_id AND product_id=NEW.product_id))
BEGIN SELECT RAISE(ABORT,'Inventory updates require a matching ledger movement'); END;
CREATE TRIGGER IF NOT EXISTS inventory_initial_zero BEFORE INSERT ON inventory WHEN NEW.quantity<>0 OR NEW.value_cents<>0
BEGIN SELECT RAISE(ABORT,'Opening inventory must use a ledger movement'); END;
CREATE TRIGGER IF NOT EXISTS inventory_cannot_delete BEFORE DELETE ON inventory BEGIN SELECT RAISE(ABORT,'Inventory cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS approval_preserve_original BEFORE UPDATE ON approval_requests
WHEN NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id OR NEW.kind<>OLD.kind OR NEW.entity_id<>OLD.entity_id OR NEW.payload_json<>OLD.payload_json OR NEW.original_json<>OLD.original_json OR NEW.reason<>OLD.reason OR NEW.business_id<>OLD.business_id OR NEW.branch_id<>OLD.branch_id OR NEW.explanation<>OLD.explanation OR NEW.requested_change<>OLD.requested_change OR NEW.created_at<>OLD.created_at OR NEW.entity<>OLD.entity OR NEW.evidence_id IS NOT OLD.evidence_id
BEGIN SELECT RAISE(ABORT,'Original approval requests are immutable'); END;
CREATE TRIGGER IF NOT EXISTS approval_no_terminal_update BEFORE UPDATE ON approval_requests WHEN OLD.status IN('approved','rejected')
BEGIN SELECT RAISE(ABORT,'A reviewed request cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS approval_no_delete BEFORE DELETE ON approval_requests BEGIN SELECT RAISE(ABORT,'Approval history cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS cash_session_preserve BEFORE UPDATE ON cash_sessions
WHEN OLD.closed_at IS NOT NULL OR NEW.id<>OLD.id OR NEW.business_id<>OLD.business_id OR NEW.branch_id<>OLD.branch_id OR NEW.user_id<>OLD.user_id OR NEW.register<>OLD.register OR NEW.opening_cents<>OLD.opening_cents OR NEW.opened_at<>OLD.opened_at OR NEW.closed_at IS NULL
BEGIN SELECT RAISE(ABORT,'Only closing a live session is allowed'); END;
CREATE TRIGGER IF NOT EXISTS cash_session_no_delete BEFORE DELETE ON cash_sessions BEGIN SELECT RAISE(ABORT,'Sessions cannot be deleted'); END;
CREATE TABLE IF NOT EXISTS purchase_reversals (
 id TEXT PRIMARY KEY, ref TEXT NOT NULL UNIQUE, business_id TEXT NOT NULL, branch_id TEXT NOT NULL,
 purchase_id TEXT NOT NULL UNIQUE, approval_id TEXT NOT NULL UNIQUE REFERENCES approval_requests(id),
 user_id TEXT NOT NULL REFERENCES users(id), total_cents INTEGER NOT NULL, inventory_cents INTEGER NOT NULL,
 reason TEXT NOT NULL, created_at TEXT NOT NULL,
 FOREIGN KEY(purchase_id,business_id,branch_id) REFERENCES purchases(id,business_id,branch_id)
);
CREATE TABLE IF NOT EXISTS supplier_refunds (
 id TEXT PRIMARY KEY, business_id TEXT NOT NULL, branch_id TEXT NOT NULL, purchase_id TEXT NOT NULL,
 reversal_id TEXT NOT NULL REFERENCES purchase_reversals(id), user_id TEXT NOT NULL REFERENCES users(id),
 session_id TEXT, method TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents>0), created_at TEXT NOT NULL,
 FOREIGN KEY(purchase_id,business_id,branch_id) REFERENCES purchases(id,business_id,branch_id),
 FOREIGN KEY(session_id,business_id,branch_id) REFERENCES cash_sessions(id,business_id,branch_id)
);
CREATE TABLE IF NOT EXISTS supplier_payment_reversals (
 id TEXT PRIMARY KEY, ref TEXT NOT NULL UNIQUE, business_id TEXT NOT NULL, branch_id TEXT NOT NULL,
 payment_id TEXT NOT NULL UNIQUE REFERENCES supplier_payments(id), purchase_id TEXT NOT NULL REFERENCES purchases(id),
 approval_id TEXT NOT NULL UNIQUE REFERENCES approval_requests(id), user_id TEXT NOT NULL REFERENCES users(id), session_id TEXT,
 method TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents>0), reason TEXT NOT NULL, created_at TEXT NOT NULL,
 FOREIGN KEY(session_id,business_id,branch_id) REFERENCES cash_sessions(id,business_id,branch_id)
);
CREATE TABLE IF NOT EXISTS reconciliation_adjustments (
 id TEXT PRIMARY KEY, ref TEXT NOT NULL UNIQUE, business_id TEXT NOT NULL, branch_id TEXT NOT NULL,
 reconciliation_id TEXT NOT NULL REFERENCES reconciliations(id), approval_id TEXT NOT NULL UNIQUE REFERENCES approval_requests(id),
 user_id TEXT NOT NULL REFERENCES users(id), previous_actual_cents INTEGER NOT NULL, actual_cents INTEGER NOT NULL CHECK(actual_cents>=0),
 previous_variance_cents INTEGER NOT NULL, variance_cents INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
 FOREIGN KEY(branch_id,business_id) REFERENCES branches(id,business_id)
);
