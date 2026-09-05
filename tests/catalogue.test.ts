import { describe, it, expect, afterEach } from 'vitest';
import { createDb, bootstrap } from '../server/db.js';
import { CATALOGUE, seedCatalogue } from '../server/catalogue.js';
import { all, one, integrity, type DB } from '../server/core.js';
import { applyPrices } from '../server/products.js';
let db: DB;
afterEach(() => db?.close());
const init = () => {
  db = createDb();
  const a = bootstrap(db, { name: 'Test', email: 'test@test.co.ke', password: 'test-password-123' });
  seedCatalogue(db, a);
  return a;
};
describe('Catalogue and manual pricing', () => {
  it('seeds sourced products with no invented prices, stock or barcodes', () => {
    init();
    expect(CATALOGUE.length).toBeGreaterThan(100);
    expect(
      all(db, 'SELECT * FROM products WHERE cost_cents IS NOT NULL OR selling_cents IS NOT NULL'),
    ).toHaveLength(0);
    expect(all(db, 'SELECT * FROM inventory WHERE quantity<>0')).toHaveLength(0);
    expect(all(db, 'SELECT * FROM product_barcodes')).toHaveLength(0);
    expect(CATALOGUE.every((p) => p.source.startsWith('https://'))).toBe(true);
    expect(integrity(db).ok).toBe(true);
  });
  it('does not overwrite prices or duplicate catalogue on startup', () => {
    const a = init();
    const first = one(db, 'SELECT * FROM products LIMIT 1')!;
    applyPrices(
      db,
      a,
      [
        {
          product_id: first.id,
          version: 1,
          cost: '100',
          selling: '150',
          wholesale: null,
          promo: null,
          tax_mode: 'none',
          tax_bps: 0,
        },
      ],
      'Manual test fixture',
    );
    seedCatalogue(db, a);
    expect(one(db, 'SELECT selling_cents FROM products WHERE id=?', first.id)?.selling_cents).toBe(15000);
    expect(all(db, 'SELECT * FROM products')).toHaveLength(CATALOGUE.length);
  });
  it('extends missing sourced entries without overwriting existing owner prices', () => {
    const omitted = CATALOGUE.splice(-3);
    let actor;
    try {
      actor = init();
    } finally {
      CATALOGUE.push(...omitted);
    }
    const first = one(db, 'SELECT * FROM products LIMIT 1')!;
    applyPrices(
      db,
      actor,
      [
        {
          product_id: first.id,
          version: first.version,
          cost: '100',
          selling: '150',
          wholesale: null,
          promo: null,
          tax_mode: 'none',
          tax_bps: 0,
        },
      ],
      'Synthetic manually entered extension-test prices',
    );
    seedCatalogue(db, actor, true);
    seedCatalogue(db, actor, true);
    expect(all(db, 'SELECT * FROM products')).toHaveLength(CATALOGUE.length);
    expect(one(db, 'SELECT selling_cents FROM products WHERE id=?', first.id)!.selling_cents).toBe(15000);
    expect(
      one(
        db,
        "SELECT size,cost_cents,selling_cents FROM products WHERE name='Homezaza Mini Bottle Opener DH1839'",
      ),
    ).toEqual({ size: '', cost_cents: null, selling_cents: null });
    expect(one(db, "SELECT COUNT(*) n FROM audit_logs WHERE action='catalogue.extended'")!.n).toBe(1);
    expect(integrity(db).ok).toBe(true);
  });
  it('audits each price change and rejects stale versions and cashier edits', () => {
    const a = init(),
      p = one(db, 'SELECT * FROM products LIMIT 1')!;
    const row = {
      product_id: p.id,
      version: 1,
      cost: '100',
      selling: '150',
      wholesale: null,
      promo: null,
      tax_mode: 'none' as const,
      tax_bps: 0,
    };
    applyPrices(db, a, [row], 'Manual price maintenance');
    expect(all(db, 'SELECT * FROM price_history')).toHaveLength(1);
    expect(() => applyPrices(db, a, [row], 'Stale request attempt')).toThrow(/updated/);
    expect(() =>
      applyPrices(db, { ...a, permissions: [] }, [{ ...row, version: 2 }], 'Unauthorised attempt'),
    ).toThrow(/permission/);
    expect(integrity(db).ok).toBe(true);
  });
});
