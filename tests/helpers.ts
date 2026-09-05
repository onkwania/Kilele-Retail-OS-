import { createDb, bootstrap, hashPassword, actorFor } from '../server/db.js';
import { seedCatalogue } from '../server/catalogue.js';
import { applyPrices } from '../server/products.js';
import { moveStock } from '../server/stock-engine.js';
import { one, id, insert, now, journal, scope, type Actor, type DB } from '../server/core.js';
export function fixture() {
  const db = createDb();
  const a = bootstrap(db, {
    name: 'Test Owner',
    email: 'owner@test.co.ke',
    password: 'test-password-strong',
  });
  seedCatalogue(db, a);
  const p = one(db, 'SELECT * FROM products LIMIT 1')!;
  db.transaction(() => {
    applyPrices(
      db,
      a,
      [
        {
          product_id: p.id,
          version: 1,
          cost: '100',
          selling: '150',
          wholesale: '140',
          promo: null,
          tax_mode: 'none',
          tax_bps: 0,
        },
      ],
      'Synthetic test fixture only',
    );
    moveStock(db, a, {
      product_id: p.id,
      quantity: 20,
      value_delta_cents: 200000,
      kind: 'opening',
      reference: 'TEST-OPEN',
      reason: 'Synthetic test stock',
    });
    journal(db, a, 'TEST-OPEN', 'Synthetic test stock', [
      { account: 'Inventory', debit: 200000 },
      { account: 'Opening equity', credit: 200000 },
    ]);
  })();
  const sessionId = id('session_');
  insert(db, 'cash_sessions', {
    id: sessionId,
    ...scope(a),
    user_id: a.id,
    register: 'Test register',
    opening_cents: 10000,
    opened_at: now(),
  });
  return { db, a, p: one(db, 'SELECT * FROM products WHERE id=?', p.id)!, sessionId };
}
export function addUser(db: DB, a: Actor, role: string, name = role) {
  const uid = id('usr_');
  insert(db, 'users', {
    id: uid,
    ...scope(a),
    role_id: role,
    name,
    email: `${uid}@test.co.ke`,
    password_hash: hashPassword('test-password-strong'),
    created_at: now(),
  });
  return actorFor(db, uid)!;
}
export const saleInput = (p: any, sessionId: string) => ({
  session_id: sessionId,
  age_confirmed: true, // Explicit synthetic adult-check attestation; no real sale is made.
  items: [{ product_id: p.id, quantity: 2, version: p.version, price_type: 'retail' }],
  discount: '0',
  discount_reason: '',
  expected_total: '300',
  payments: [
    { method: 'Cash', amount: '100', tendered: '150' },
    { method: 'M-Pesa', amount: '200', reference: 'TEST-MPESA-001' },
  ],
});
