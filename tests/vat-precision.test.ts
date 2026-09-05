import { describe, it, expect, afterEach } from 'vitest';
import { fixture, addUser, saleInput } from './helpers.js';
import { all, one, id, insert, scope, now, kenyaDate, integrity, type DB } from '../server/core.js';
import { applyPrices } from '../server/products.js';
import { createSale } from '../server/sales.js';
import { createPurchase, saveSupplier, recordSupplierPayment } from '../server/inventory.js';
import { createExpense } from '../server/expenses.js';
import { createCorrectionRequest, reviewRequest } from '../server/approvals.js';
import { getReport } from '../server/reports.js';
import { stats } from '../server/analytics.js';
let db: DB;
afterEach(() => db?.close());
const note = {
  reason: 'Synthetic invoice / allocation correction',
  explanation: 'Original invoice and recorded allocations have been checked',
  requested_change: 'Reverse the original values with a linked entry',
};
describe('VAT claims and exact cumulative refunds', () => {
  it('separates manually claimed input VAT from inventory, supplier liability and expense cost', () => {
    const f = fixture();
    db = f.db;
    const supplier = saveSupplier(db, f.a, {
      name: 'Synthetic VAT supplier',
      reason: 'Explicit tax fixture',
    });
    const purchase = db.transaction(() =>
      createPurchase(db, f.a, {
        supplier_id: supplier.id,
        invoice_ref: 'VAT-INVOICE',
        purchase_date: kenyaDate(),
        payment_method: 'Credit',
        input_tax: '32',
        items: [{ product_id: f.p.id, quantity: 2, cost: '100' }],
        reason: 'Net valuation and deductible tax recorded separately',
      }),
    )();
    expect(one(db, 'SELECT total_cents,input_tax_cents FROM purchases WHERE id=?', purchase.id)).toEqual({
      total_cents: 23200,
      input_tax_cents: 3200,
    });
    expect(one(db, 'SELECT value_cents FROM inventory WHERE product_id=?', f.p.id)!.value_cents).toBe(220000);
    const expense = db.transaction(() =>
      createExpense(db, f.a, {
        category: 'Repairs',
        amount: '116',
        input_tax: '16',
        expense_date: kenyaDate(),
        method: 'Bank',
        reference: 'VAT-EXP-REF',
        description: 'Synthetic gross paid and input VAT claim',
      }),
    )();
    expect(stats(db, f.a, { from: kenyaDate(), to: kenyaDate() }).expenses_cents).toBe(10000);
    expect(
      one(db, "SELECT SUM(debit_cents-credit_cents) n FROM journal_lines WHERE account='Input VAT'")!.n,
    ).toBe(4800);
    db.transaction(() =>
      recordSupplierPayment(db, f.a, one(db, 'SELECT * FROM purchases WHERE id=?', purchase.id)!, {
        amount: '232',
        method: 'Bank',
        reference: 'VAT-TRANSFER-TEST',
      }),
    )();
    const purchases = getReport(db, f.a, 'purchases', {});
    expect(purchases.totals.invoice_payable_cents).toBe(23200);
    expect(purchases.totals.invoice_tax_cents).toBe(3200);
    expect(purchases.totals.total_cents).toBe(20000);
    expect(getReport(db, f.a, 'payments', { source: 'supplier' }).totals.amount_cents).toBe(-23200);
    expect(integrity(db).ok).toBe(true);
    const reviewer = addUser(db, f.a, 'admin');
    for (const [kind, entity_id] of [
      ['purchase_reversal', purchase.id],
      ['expense_reversal', expense.id],
    ]) {
      const req = createCorrectionRequest(db, f.a, { ...note, kind, entity_id });
      db.transaction(() =>
        reviewRequest(db, reviewer, req.id, {
          action: 'approve',
          reason: 'Original tax amounts independently reviewed',
        }),
      )();
    }
    expect(
      one(db, "SELECT SUM(debit_cents-credit_cents) n FROM journal_lines WHERE account='Input VAT'")!.n,
    ).toBe(0);
    expect(one(db, 'SELECT value_cents FROM inventory WHERE product_id=?', f.p.id)!.value_cents).toBe(200000);
    expect(stats(db, f.a, { from: kenyaDate(), to: kenyaDate() }).expenses_cents).toBe(0);
    expect(integrity(db).ok).toBe(true);
  });
  it('never refunds more VAT than gross money on penny-rounded partial returns', () => {
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
          tax_mode: 'inclusive',
          tax_bps: 1600,
        },
      ],
      'Explicit synthetic 16 percent rounding fixture, not a tax default',
    );
    const p = one(db, 'SELECT * FROM products WHERE id=?', f.p.id)!;
    const sale = db.transaction(() =>
      createSale(db, f.a, {
        ...saleInput(p, f.sessionId),
        items: [{ product_id: p.id, version: p.version, quantity: 7, price_type: 'retail' }],
        discount: '0.03',
        discount_reason: 'Synthetic fractional allocation',
        expected_total: '0.04',
        payments: [{ method: 'Cash', amount: '0.04' }],
      }),
    )();
    const reviewer = addUser(db, f.a, 'admin');
    insert(db, 'cash_sessions', {
      id: id(),
      ...scope(reviewer),
      user_id: reviewer.id,
      register: 'VAT refund review',
      opening_cents: 100,
      opened_at: now(),
    });
    const item = one(db, 'SELECT id FROM sale_items WHERE sale_id=?', sale.id)!;
    for (let i = 0; i < 7; i++) {
      const req = createCorrectionRequest(db, f.a, {
        ...note,
        kind: 'sale_return',
        entity_id: sale.id,
        payload: { items: [{ sale_item_id: item.id, quantity: 1 }] },
      });
      db.transaction(() =>
        reviewRequest(db, reviewer, req.id, {
          action: 'approve',
          reason: 'Original allocation and physical unit verified',
        }),
      )();
    }
    const entries = all(db, 'SELECT * FROM sale_return_items');
    expect(entries.every((r) => r.tax_cents >= 0 && r.tax_cents <= r.total_cents)).toBe(true);
    expect(entries.reduce((s, r) => s + r.total_cents, 0)).toBe(4);
    expect(entries.reduce((s, r) => s + r.tax_cents, 0)).toBe(1);
    expect(one(db, 'SELECT quantity FROM inventory WHERE product_id=?', p.id)!.quantity).toBe(20);
    expect(integrity(db).ok).toBe(true);
  });
});
