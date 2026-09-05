import { describe, it, expect, afterEach } from 'vitest';
import { fixture, addUser, saleInput } from './helpers.js';
import { createSale } from '../server/sales.js';
import { createExpense, closeSession } from '../server/expenses.js';
import { createCorrectionRequest, reviewRequest } from '../server/approvals.js';
import { createPurchase, saveSupplier, stockRequest } from '../server/inventory.js';
import { integrity, one, all, kenyaDate, insert, id, scope, now, type DB } from '../server/core.js';
let db: DB;
afterEach(() => db?.close());
const ownRegister = (f: any, actor: any) => {
  insert(f.db, 'cash_sessions', {
    id: id(),
    ...scope(actor),
    user_id: actor.id,
    register: id(),
    opening_cents: 100000,
    opened_at: now(),
  });
};
describe('Independent approvals and linked reversals', () => {
  it('blocks self-approval and preserves originals after a sale reversal', () => {
    const f = fixture();
    db = f.db;
    const admin = addUser(db, f.a, 'admin');
    ownRegister(f, admin);
    const sale = db.transaction(() => createSale(db, f.a, saleInput(f.p, f.sessionId)))();
    const r = createCorrectionRequest(db, f.a, {
      explanation: 'Synthetic test: inspect the recorded transaction and evidence.',
      requested_change: 'Apply the linked correction described by this test case.',
      kind: 'sale_void',
      entity_id: sale.id,
      reason: 'Customer cancelled purchase',
    });
    expect(() =>
      reviewRequest(db, f.a, r.id, { action: 'approve', reason: 'I cannot approve my own' }),
    ).toThrow(/own request/);
    db.transaction(() =>
      reviewRequest(db, admin, r.id, { action: 'approve', reason: 'Original checked; full refund received' }),
    )();
    expect(one(db, 'SELECT total_cents FROM sales WHERE id=?', sale.id)!.total_cents).toBe(30000);
    expect(one(db, 'SELECT quantity FROM inventory WHERE product_id=?', f.p.id)!.quantity).toBe(20);
    expect(all(db, 'SELECT * FROM sale_reversals')).toHaveLength(1);
    expect(integrity(db).ok).toBe(true);
    expect(() =>
      reviewRequest(db, admin, r.id, { action: 'approve', reason: 'Try duplicate approval' }),
    ).toThrow(/pending/);
  });
  it('handles partial returns without exceeding quantities or tender balances', () => {
    const f = fixture();
    db = f.db;
    const admin = addUser(db, f.a, 'admin');
    ownRegister(f, admin);
    const sale = db.transaction(() => createSale(db, f.a, saleInput(f.p, f.sessionId)))();
    const item = one(db, 'SELECT * FROM sale_items WHERE sale_id=?', sale.id)!;
    for (let n = 0; n < 2; n++) {
      const r = createCorrectionRequest(db, f.a, {
        explanation: 'Synthetic test: inspect the recorded transaction and evidence.',
        requested_change: 'Apply the linked correction described by this test case.',
        kind: 'sale_return',
        entity_id: sale.id,
        reason: 'One unit returned',
        payload: { items: [{ sale_item_id: item.id, quantity: 1 }] },
      });
      db.transaction(() =>
        reviewRequest(db, admin, r.id, { action: 'approve', reason: 'Item inspected and refund confirmed' }),
      )();
    }
    expect(one(db, 'SELECT SUM(amount_cents) n FROM payments WHERE sale_id=?', sale.id)!.n).toBe(0);
    expect(() =>
      createCorrectionRequest(db, f.a, {
        explanation: 'Synthetic test: inspect the recorded transaction and evidence.',
        requested_change: 'Apply the linked correction described by this test case.',
        kind: 'sale_return',
        entity_id: sale.id,
        reason: 'Excess refund attempt',
        payload: { items: [{ sale_item_id: item.id, quantity: 1 }] },
      }),
    ).toThrow(/remaining/);
    expect(integrity(db).ok).toBe(true);
  });
  it('creates an expense reversal and replacement without mutating posted history', () => {
    const f = fixture();
    db = f.db;
    const admin = addUser(db, f.a, 'admin');
    const e = db.transaction(() =>
      createExpense(db, f.a, {
        category: 'Transport',
        amount: '100',
        method: 'Bank',
        description: 'Original receipt',
        expense_date: kenyaDate(),
      }),
    )();
    const r = createCorrectionRequest(db, f.a, {
      explanation: 'Synthetic test: inspect the recorded transaction and evidence.',
      requested_change: 'Apply the linked correction described by this test case.',
      kind: 'expense_correction',
      entity_id: e.id,
      reason: 'Receipt entered with wrong amount',
      payload: {
        replacement: {
          category: 'Transport',
          amount: '80',
          method: 'Bank',
          description: 'Corrected receipt',
          expense_date: kenyaDate(),
        },
      },
    });
    db.transaction(() =>
      reviewRequest(db, admin, r.id, {
        action: 'approve',
        reason: 'Confirmed receipt against bank statement',
      }),
    )();
    expect(one(db, 'SELECT amount_cents FROM expenses WHERE id=?', e.id)!.amount_cents).toBe(10000);
    expect(all(db, 'SELECT * FROM expenses')).toHaveLength(2);
    expect(integrity(db).ok).toBe(true);
  });
  it('approves staff receiving and rejects stock movements when a request is rejected', () => {
    const f = fixture();
    db = f.db;
    const staff = addUser(db, f.a, 'accountant');
    const supplier = saveSupplier(db, f.a, { name: 'Test supplier', reason: 'Set up test supplier' });
    const p = db.transaction(() =>
      createPurchase(db, staff, {
        supplier_id: supplier.id,
        invoice_ref: 'TEST-APP-INV',
        purchase_date: kenyaDate(),
        payment_method: 'Credit',
        items: [{ product_id: f.p.id, quantity: 2, cost: '110' }],
        reason: 'Stock delivery checked',
      }),
    )();
    const r = one(db, 'SELECT * FROM approval_requests WHERE entity_id=?', p.id)!;
    db.transaction(() =>
      reviewRequest(db, f.a, r.id, { action: 'approve', reason: 'Delivery note checked' }),
    )();
    expect(one(db, 'SELECT quantity FROM inventory WHERE product_id=?', f.p.id)!.quantity).toBe(22);
    const waste = stockRequest(db, staff, {
      product_id: f.p.id,
      kind: 'wastage',
      quantity: 1,
      reason: 'Bottle reported broken',
    });
    db.transaction(() =>
      reviewRequest(db, f.a, waste.id, { action: 'reject', reason: 'Bottle located on shelf' }),
    )();
    expect(one(db, 'SELECT quantity FROM inventory WHERE product_id=?', f.p.id)!.quantity).toBe(22);
    expect(integrity(db).ok).toBe(true);
  });
  it('preserves a submitted closing and posts a separate approved correction', () => {
    const f = fixture();
    db = f.db;
    const admin = addUser(db, f.a, 'admin');
    const closing = db.transaction(() =>
      closeSession(db, f.a, f.sessionId, { actual: '90', explanation: 'Count was short pending review' }),
    )();
    db.transaction(() =>
      reviewRequest(db, admin, closing.request_id, { action: 'approve', reason: 'Initial count verified' }),
    )();
    const r = createCorrectionRequest(db, f.a, {
      explanation: 'Synthetic test: inspect the recorded transaction and evidence.',
      requested_change: 'Apply the linked correction described by this test case.',
      kind: 'closing_correction',
      entity_id: closing.id,
      reason: 'Found omitted cash denomination',
      payload: { actual: '100' },
    });
    db.transaction(() =>
      reviewRequest(db, admin, r.id, { action: 'approve', reason: 'Recount witnessed and confirmed' }),
    )();
    expect(one(db, 'SELECT actual_cents FROM reconciliations WHERE id=?', closing.id)!.actual_cents).toBe(
      9000,
    );
    expect(one(db, 'SELECT variance_cents FROM reconciliation_adjustments')!.variance_cents).toBe(0);
    expect(integrity(db).ok).toBe(true);
  });
  it('makes approval original payload and terminal decisions immutable', () => {
    const f = fixture();
    db = f.db;
    const admin = addUser(db, f.a, 'admin');
    const r = createCorrectionRequest(db, f.a, {
      explanation: 'Synthetic test: inspect the recorded transaction and evidence.',
      requested_change: 'Apply the linked correction described by this test case.',
      kind: 'other',
      reason: 'Please review this control note',
    });
    expect(() => db.prepare("UPDATE approval_requests SET payload_json='{}' WHERE id=?").run(r.id)).toThrow(
      /immutable/,
    );
    db.transaction(() =>
      reviewRequest(db, admin, r.id, { action: 'reject', reason: 'No action is needed here' }),
    )();
    expect(() => db.prepare("UPDATE approval_requests SET status='pending' WHERE id=?").run(r.id)).toThrow(
      /cannot be changed/,
    );
    expect(() => db.prepare('DELETE FROM approval_requests').run()).toThrow(/cannot be deleted/);
  });
});
