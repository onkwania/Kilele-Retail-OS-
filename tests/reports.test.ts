import { describe, it, expect, afterEach } from 'vitest';
import { fixture, saleInput, addUser } from './helpers.js';
import { createSale } from '../server/sales.js';
import { getReport, csvReport, csvCell } from '../server/reports.js';
import { kenyaDate, type DB } from '../server/core.js';
let db: DB;
afterEach(() => db?.close());
describe('Scoped reports and exports', () => {
  it('reports each sale line once even with split payments and applies product/staff filters', () => {
    const f = fixture();
    db = f.db;
    db.transaction(() => createSale(db, f.a, saleInput(f.p, f.sessionId)))();
    const r = getReport(db, f.a, 'sales', {
      from: kenyaDate(),
      to: kenyaDate(),
      product: f.p.id,
      payment: 'M-Pesa',
    });
    expect(r.count).toBe(1);
    expect(r.totals.total_cents).toBe(30000);
    expect(csvReport(r)).toContain('300.00');
    expect(
      getReport(db, f.a, 'sales', { from: kenyaDate(), to: kenyaDate(), product: 'not-a-real-id' }).count,
    ).toBe(0);
  });
  it('reconstructs inventory from movements and disallows unsupported filters', () => {
    const f = fixture();
    db = f.db;
    const r = getReport(db, f.a, 'inventory', { from: kenyaDate(), to: kenyaDate(), product: f.p.id });
    expect(r.rows[0].closing_stock).toBe(20);
    expect(r.rows[0].stock_value_cents).toBe(200000);
    expect(r.rows[0].adjustments).toBe(20);
    expect(() => getReport(db, f.a, 'inventory', { payment: 'Cash' })).toThrow(/not available/);
  });
  it('neutralises CSV formula injection and enforces report permissions', () => {
    const f = fixture();
    db = f.db;
    const cashier = addUser(db, f.a, 'cashier');
    expect(csvCell('=HYPERLINK("bad")')).toContain("'=HYPERLINK");
    expect(csvCell('-40.50')).toBe('"-40.50"');
    expect(() => getReport(db, cashier, 'profit', {})).toThrow(/permission/);
  });
});
