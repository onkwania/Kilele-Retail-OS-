import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { scryptSync, randomBytes } from 'node:crypto';
import { all, audit, id, insert, now, one, type DB, type Actor } from './core.js';
import { PERMISSIONS, ROLE_NAMES, ROLE_PERMISSIONS } from './permissions.js';

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex')}`;
}
const immutable = ['purchase_reversals','supplier_refunds','supplier_payment_reversals','reconciliation_adjustments','sales','sale_items','payments','expenses','expense_reversals','sale_reversals','sale_return_items','purchases','purchase_items','purchase_receipts','supplier_payments','inventory_movements','reconciliations','documents','journal_entries','journal_lines','audit_logs','price_history','approval_events','idempotency_keys'];
export function createDb(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('busy_timeout = 5000');
  db.exec(readFileSync(resolve('server/schema.sql'), 'utf8'));
  for (const table of immutable) {
    for (const op of ['UPDATE','DELETE']) db.exec(`CREATE TRIGGER IF NOT EXISTS immutable_${table}_${op.toLowerCase()} BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT, '${table} records are immutable; request a correction'); END;`);
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS movement_matches_inventory BEFORE INSERT ON inventory_movements
    WHEN NOT EXISTS(SELECT 1 FROM inventory WHERE business_id=NEW.business_id AND branch_id=NEW.branch_id AND product_id=NEW.product_id AND quantity=NEW.previous_qty AND value_cents=NEW.previous_value_cents)
    BEGIN SELECT RAISE(ABORT,'Stock changed; reload before posting'); END;
    CREATE TRIGGER IF NOT EXISTS movement_updates_inventory AFTER INSERT ON inventory_movements
    BEGIN UPDATE inventory SET quantity=NEW.new_qty, value_cents=NEW.new_value_cents, version=version+1
    WHERE business_id=NEW.business_id AND branch_id=NEW.branch_id AND product_id=NEW.product_id; END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS product_price_guard BEFORE UPDATE ON products
    WHEN (NEW.cost_cents IS NOT OLD.cost_cents OR NEW.selling_cents IS NOT OLD.selling_cents OR NEW.wholesale_cents IS NOT OLD.wholesale_cents OR NEW.promo_cents IS NOT OLD.promo_cents OR NEW.tax_mode<>OLD.tax_mode OR NEW.tax_bps<>OLD.tax_bps)
    AND NOT EXISTS(SELECT 1 FROM price_history h WHERE h.product_id=OLD.id
      AND json_extract(h.previous_json,'$.cost_cents') IS OLD.cost_cents AND json_extract(h.next_json,'$.cost_cents') IS NEW.cost_cents
      AND json_extract(h.previous_json,'$.selling_cents') IS OLD.selling_cents AND json_extract(h.next_json,'$.selling_cents') IS NEW.selling_cents
      AND json_extract(h.previous_json,'$.wholesale_cents') IS OLD.wholesale_cents AND json_extract(h.next_json,'$.wholesale_cents') IS NEW.wholesale_cents
      AND json_extract(h.previous_json,'$.promo_cents') IS OLD.promo_cents AND json_extract(h.next_json,'$.promo_cents') IS NEW.promo_cents
      AND json_extract(h.previous_json,'$.tax_mode') IS OLD.tax_mode AND json_extract(h.next_json,'$.tax_mode') IS NEW.tax_mode
      AND json_extract(h.previous_json,'$.tax_bps') IS OLD.tax_bps AND json_extract(h.next_json,'$.tax_bps') IS NEW.tax_bps
      AND h.rowid=(SELECT MAX(rowid) FROM price_history WHERE product_id=OLD.id))
    BEGIN SELECT RAISE(ABORT,'Price changes require a matching immutable price history'); END;`);
  db.transaction(() => {
    for (const [key, description] of Object.entries(PERMISSIONS)) db.prepare('INSERT OR IGNORE INTO permissions VALUES(?,?)').run(key, description);
    for (const [key, name] of Object.entries(ROLE_NAMES)) {
      db.prepare('INSERT OR IGNORE INTO roles VALUES(?,?)').run(key, name);
      for (const perm of ROLE_PERMISSIONS[key]) db.prepare('INSERT OR IGNORE INTO role_permissions VALUES(?,?)').run(key, perm);
    }
    db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES(1,?)').run(now());
  })();
  return db;
}
export function actorFor(db: DB, userId: string): Actor | null {
  const user = one(db, 'SELECT id,business_id,branch_id,role_id,name,email,must_change_password FROM users WHERE id=? AND active=1', userId);
  if (!user) return null;
  const perms = all(db, 'SELECT permission_id FROM role_permissions WHERE role_id=?', user.role_id).map(r => r.permission_id as string);
  for (const override of all(db, 'SELECT * FROM user_permissions WHERE user_id=?', userId)) {
    const index = perms.indexOf(override.permission_id);
    if (!override.allowed && index >= 0) perms.splice(index, 1);
    if (override.allowed && index < 0) perms.push(override.permission_id);
  }
  return { ...user, permissions: perms } as Actor;
}
export function bootstrap(db: DB, details: { name: string; email: string; password: string; business?: string }) {
  if (one(db, 'SELECT id FROM users LIMIT 1')) throw new Error('Database is already initialised. Bootstrap is one-time only.');
  return db.transaction(() => {
    const businessId = id('biz_'), branchId = id('br_'), userId = id('usr_');
    insert(db, 'businesses', { id: businessId, name: details.business ?? 'My beverage business', created_at: now() });
    insert(db, 'branches', { id: branchId, business_id: businessId, name: 'Main branch', location: 'Nairobi, Kenya' });
    insert(db, 'users', { id: userId, business_id: businessId, branch_id: branchId, role_id: 'super_admin', name: details.name, email: details.email.toLowerCase(), password_hash: hashPassword(details.password), created_at: now() });
    const actor = actorFor(db, userId)!;
    audit(db, actor, 'workspace.created', 'businesses', businessId, null, { name: details.business }, 'Initial owner bootstrap');
    return actor;
  }).immediate();
}
