import { describe, it, expect, afterEach } from 'vitest';
import { fixture, saleInput } from './helpers.js';
import { createExpense, closeSession } from '../server/expenses.js';
import { createSale } from '../server/sales.js';
import { sessionTotals } from '../server/stock-engine.js';
import { integrity, one, kenyaDate, type DB } from '../server/core.js';
let db: DB;
afterEach(() => db?.close());
describe('Expenses and cash closing', () => {
  it('posts immutable expenses and reconciles exact net cash, excluding change', () => {
    const f = fixture();
    db = f.db;
    db.transaction(() => createSale(db, f.a, saleInput(f.p, f.sessionId)))();
    db.transaction(() =>
      createExpense(db, f.a, {
        category: 'Transport',
        amount: '50',
        method: 'Cash',
        description: 'Fixture delivery fare',
        expense_date: kenyaDate(),
      }),
    )();
    const t = sessionTotals(db, f.a, f.sessionId);
    expect(t.expected_cents).toBe(15000);
    expect(t.mpesa_cents).toBe(20000);
    expect(() => db.prepare('DELETE FROM expenses').run()).toThrow(/immutable/);
    expect(integrity(db).ok).toBe(true);
  });
  it('requires variance reasons and locks a closed session', () => {
    const f = fixture();
    db = f.db;
    expect(() => closeSession(db, f.a, f.sessionId, { actual: '90' })).toThrow(/Explain/);
    const result = db.transaction(() =>
      closeSession(db, f.a, f.sessionId, {
        actual: '90',
        explanation: 'Physical cash differs; review required',
      }),
    )();
    expect(result.variance_cents).toBe(-1000);
    expect(one(db, "SELECT status FROM approval_requests WHERE kind='daily_closing'")!.status).toBe(
      'pending',
    );
    expect(() => createSale(db, f.a, saleInput(f.p, f.sessionId))).toThrow(/session/);
    expect(() => db.prepare('UPDATE reconciliations SET actual_cents=1').run()).toThrow(/immutable/);
  });
  it('rejects cash spending without enough float and zero amounts', () => {
    const f = fixture();
    db = f.db;
    expect(() =>
      createExpense(db, f.a, {
        category: 'Other',
        amount: '101',
        method: 'Cash',
        description: 'Too much spending',
        expense_date: kenyaDate(),
      }),
    ).toThrow(/expected cash/);
    expect(() =>
      createExpense(db, f.a, {
        category: 'Other',
        amount: '0',
        method: 'Bank',
        description: 'Invalid zero expense',
        expense_date: kenyaDate(),
      }),
    ).toThrow(/greater than zero/);
  });
});
