import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, addUser, saleInput } from './helpers.js';
import { createSale } from '../server/sales.js';
import { createCorrectionRequest, reviewRequest } from '../server/approvals.js';
import { saveSupplier, createPurchase, recordSupplierPayment } from '../server/inventory.js';
import { applyPrices } from '../server/products.js';
import { createDb } from '../server/db.js';
import { one, all, insert, id, now, scope, kenyaDate, integrity, type DB } from '../server/core.js';
let db: DB;
const dirs: string[] = [];
afterEach(() => {
  db?.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const narrative = {
  reason: 'Synthetic independently reviewed correction',
  explanation: 'Inspect the original recorded document and actual returned units',
  requested_change: 'Post a linked correction and retain the original',
};
describe('Second-pass accounting and compatibility', () => {
  it('restocks zero-cent partial returns and conserves the full original money and COGS', () => {
    const f = fixture();
    db = f.db;
    applyPrices(
      db,
      f.a,
      [
        {
          product_id: f.p.id,
          version: f.p.version,
          cost: '100',
          selling: '0.01',
          wholesale: null,
          promo: null,
          tax_mode: 'none',
          tax_bps: 0,
        },
      ],
      'Synthetic cent-rounding fixture',
    );
    const p = one(db, 'SELECT * FROM products WHERE id=?', f.p.id)!;
    const b = {
      ...saleInput(p, f.sessionId),
      items: [{ product_id: p.id, version: p.version, quantity: 3, price_type: 'retail' }],
      discount: '0.02',
      discount_reason: 'Synthetic steep discount',
      expected_total: '0.01',
      payments: [{ method: 'Cash', amount: '0.01' }],
    };
    const sale = db.transaction(() => createSale(db, f.a, b))();
    const reviewer = addUser(db, f.a, 'admin');
    insert(db, 'cash_sessions', {
      id: id(),
      ...scope(reviewer),
      user_id: reviewer.id,
      register: 'Cent review',
      opening_cents: 100,
      opened_at: now(),
    });
    const item = one(db, 'SELECT * FROM sale_items WHERE sale_id=?', sale.id)!;
    for (let i = 0; i < 3; i++) {
      const r = createCorrectionRequest(db, f.a, {
        ...narrative,
        kind: 'sale_return',
        entity_id: sale.id,
        payload: { items: [{ sale_item_id: item.id, quantity: 1 }] },
      });
      db.transaction(() =>
        reviewRequest(db, reviewer, r.id, {
          action: 'approve',
          reason: 'Checked original allocation and returned stock',
        }),
      )();
    }
    expect(all(db, 'SELECT total_cents FROM sale_reversals').map((r) => r.total_cents)).toEqual([0, 1, 0]);
    expect(one(db, 'SELECT SUM(quantity) n FROM sale_return_items')!.n).toBe(3);
    expect(one(db, 'SELECT SUM(amount_cents) n FROM payments WHERE sale_id=?', sale.id)!.n).toBe(0);
    expect(one(db, 'SELECT quantity,value_cents FROM inventory WHERE product_id=?', p.id)).toEqual({
      quantity: 20,
      value_cents: 200000,
    });
    expect(integrity(db).ok).toBe(true);
  });
  it('appends a linked replacement to rejected receiving and requires another reviewer even when entered by admin', () => {
    const f = fixture();
    db = f.db;
    const staff = addUser(db, f.a, 'accountant'),
      reviewer = addUser(db, f.a, 'admin'),
      sup = saveSupplier(db, f.a, { name: 'Synthetic audit supplier', reason: 'Fixture supplier setup' });
    const body = {
      supplier_id: sup.id,
      invoice_ref: 'UNCHANGED-REAL-INVOICE',
      purchase_date: kenyaDate(),
      payment_method: 'Credit',
      items: [{ product_id: f.p.id, quantity: 4, cost: '120' }],
      reason: 'Original wrong quantity',
    };
    const original = db.transaction(() => createPurchase(db, staff, body))();
    db.transaction(() =>
      reviewRequest(db, f.a, original.request_id!, {
        action: 'reject',
        reason: 'Correct the captured package quantity',
      }),
    )();
    expect(() => db.transaction(() => createPurchase(db, f.a, body))()).toThrow(/linked replacement/);
    const correct = db.transaction(() =>
      createPurchase(db, f.a, {
        ...body,
        replaces_id: original.id,
        items: [{ ...body.items[0], quantity: 2 }],
        reason: 'Corrected quantity against the same invoice',
      }),
    )();
    expect(correct.status).toBe('pending');
    expect(one(db, 'SELECT quantity FROM inventory WHERE product_id=?', f.p.id)!.quantity).toBe(20);
    expect(() =>
      reviewRequest(db, f.a, correct.request_id!, {
        action: 'approve',
        reason: 'Cannot approve own correction',
      }),
    ).toThrow(/own request/);
    db.transaction(() =>
      reviewRequest(db, reviewer, correct.request_id!, {
        action: 'approve',
        reason: 'Correct invoice quantity independently verified',
      }),
    )();
    expect(
      one(db, 'SELECT invoice_ref,replaces_id,total_cents FROM purchases WHERE id=?', correct.id),
    ).toEqual({ invoice_ref: body.invoice_ref, replaces_id: original.id, total_cents: 24000 });
    expect(one(db, 'SELECT total_cents FROM purchases WHERE id=?', original.id)!.total_cents).toBe(48000);
    expect(integrity(db).ok).toBe(true);
  });
  it('requires real immediate electronic settlement references and prevents duplicate transfers', () => {
    const f = fixture();
    db = f.db;
    const sup = saveSupplier(db, f.a, {
      name: 'Synthetic settlement supplier',
      reason: 'Fixture supplier setup',
    });
    const body = {
      supplier_id: sup.id,
      invoice_ref: 'INV-ONE',
      purchase_date: kenyaDate(),
      payment_method: 'Bank',
      items: [{ product_id: f.p.id, quantity: 2, cost: '100' }],
      reason: 'Electronic invoice receiving',
    };
    expect(() => db.transaction(() => createPurchase(db, f.a, body))()).toThrow(/provider reference/);
    const posted = db.transaction(() =>
      createPurchase(db, f.a, { ...body, payment_reference: 'TRANSFER-ABC' }),
    )();
    expect(one(db, 'SELECT reference FROM supplier_payments WHERE purchase_id=?', posted.id)!.reference).toBe(
      'TRANSFER-ABC',
    );
    const other = db.transaction(() =>
      createPurchase(db, f.a, { ...body, invoice_ref: 'INV-TWO', payment_method: 'Credit' }),
    )();
    expect(() =>
      db.transaction(() =>
        recordSupplierPayment(db, f.a, one(db, 'SELECT * FROM purchases WHERE id=?', other.id)!, {
          method: 'Bank',
          amount: '50',
          reference: ' transfer-abc ',
        }),
      )(),
    ).toThrow(/already recorded/);
    expect(integrity(db).ok).toBe(true);
  });
  it('migrates populated v1 tables without altering any existing fields, child references or audit hashes', async () => {
    const f = fixture();
    db = f.db;
    db.transaction(() => createSale(db, f.a, saleInput(f.p, f.sessionId)))();
    const sup = saveSupplier(db, f.a, {
      name: 'Synthetic migration supplier',
      reason: 'Migration fixture setup',
    });
    db.transaction(() =>
      createPurchase(db, f.a, {
        supplier_id: sup.id,
        invoice_ref: 'OLD-INVOICE',
        purchase_date: kenyaDate(),
        payment_method: 'Credit',
        items: [{ product_id: f.p.id, quantity: 2, cost: '90' }],
        reason: 'Legacy receipt fixture',
      }),
    )();
    const v1 = readFileSync('tests/fixtures/schema-v1.sql', 'utf8');
    db.pragma('foreign_keys=OFF');
    db.transaction(() => {
      for (const table of ['sales', 'sale_items', 'purchases', 'sale_reversals']) {
        const begin = v1.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`),
          end = v1.indexOf('\n);', begin);
        const definition = v1
          .slice(begin, end + 4)
          .replace(`CREATE TABLE IF NOT EXISTS ${table}`, `CREATE TABLE ${table}_old`);
        db.exec(definition);
        const columns = all(db, `PRAGMA table_info(${table}_old)`)
          .map((r) => r.name)
          .join(',');
        db.exec(
          `INSERT INTO ${table}_old(${columns}) SELECT ${columns} FROM ${table};DROP TABLE ${table};ALTER TABLE ${table}_old RENAME TO ${table};`,
        );
      }
      db.prepare('DELETE FROM schema_migrations WHERE version>1').run();
    })();
    db.pragma('foreign_keys=ON');
    const tables = [
      'sales',
      'sale_items',
      'purchases',
      'purchase_items',
      'purchase_receipts',
      'inventory_movements',
      'journal_entries',
      'journal_lines',
      'audit_logs',
    ];
    const before = Object.fromEntries(tables.map((t) => [t, all(db, `SELECT * FROM ${t} ORDER BY rowid`)]));
    const dir = mkdtempSync(join(tmpdir(), 'kilele-v1-'));
    dirs.push(dir);
    const file = join(dir, 'old.sqlite');
    await db.backup(file);
    db.close();
    db = createDb(file);
    for (const table of tables) {
      const after = all(db, `SELECT * FROM ${table} ORDER BY rowid`);
      expect(after).toHaveLength(before[table].length);
      for (let i = 0; i < after.length; i++)
        for (const [column, value] of Object.entries(before[table][i]))
          expect(after[i][column], table + '.' + column).toEqual(value);
    }
    expect(one(db, 'SELECT version FROM schema_migrations WHERE version=2')!.version).toBe(2);
    expect(integrity(db).ok).toBe(true);
  });
});
