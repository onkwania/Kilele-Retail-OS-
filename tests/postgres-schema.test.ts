import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readdirSync } from 'node:fs';
import { id, now } from '../server/core.js';
import { closePool, getPool, setPool } from '../server/postgres/db.js';
import { migrate } from '../server/postgres/migrate.js';
import { REQUIRED_TRIGGERS, assertProtections, verifyProtections } from '../server/postgres/integrity.js';
import { transaction, type Tx } from '../server/postgres/transaction.js';
import { exec, one, translate } from '../server/postgres/query.js';
import { integrity, verifyAudit } from '../server/postgres/check.js';
import { seedReferenceData } from '../server/postgres/bootstrap.js';
import { audit } from '../server/postgres/audit.js';

/**
 * Behavioural verification of the PostgreSQL schema, triggers and ledger checks against a real
 * PostgreSQL server.
 *
 * This is the evidence that the financial protections survived the migration: every assertion
 * below is a write that the SQLite ledger rejects, attempted against PostgreSQL and expected to
 * fail with the SAME message the API already returns to users.
 *
 * Running it:
 *   DATABASE_URL=postgres://... npm run db:pg:test
 * Set REQUIRE_POSTGRES_TESTS=1 in CI so a missing DATABASE_URL fails instead of silently
 * skipping. Each run creates its own scratch schema (a Supabase project has one database, so
 * tests cannot each create one) and drops it afterwards.
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim() ?? '';
const REQUIRED = process.env.REQUIRE_POSTGRES_TESTS === '1';

if (!DATABASE_URL && REQUIRED) {
  throw new Error(
    'REQUIRE_POSTGRES_TESTS=1 but DATABASE_URL is not set. Start a PostgreSQL server (or the CI service container) and export DATABASE_URL.',
  );
}
if (!DATABASE_URL) {
  console.warn(
    '[postgres-schema] SKIPPED - DATABASE_URL is not set. The PostgreSQL schema, triggers and ledger checks were NOT verified by this run. ' +
      'Export DATABASE_URL (and REQUIRE_POSTGRES_TESTS=1 in CI) to run them.',
  );
}

const describePg = DATABASE_URL ? describe : describe.skip;
const SCHEMA = `kilele_pg_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

/** Ids created by the fixture, shared by every test. */
const fx: Record<string, string> = {};

async function raw(sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

/** Runs `body` and asserts it was rejected with exactly `message`. */
async function rejected(body: () => Promise<unknown>, message: string) {
  let error: unknown = null;
  try {
    await body();
  } catch (caught) {
    error = caught;
  }
  expect(error, `expected rejection with "${message}"`).not.toBeNull();
  expect((error as Error).message).toContain(message);
}

/** Tampering helpers: the table owner can suspend triggers, which is how we simulate a
 *  database that was edited behind the application's back. */
async function withoutTriggers(table: string, body: () => Promise<void>) {
  await exec(getPool(), `ALTER TABLE ${table} DISABLE TRIGGER USER`);
  try {
    await body();
  } finally {
    await exec(getPool(), `ALTER TABLE ${table} ENABLE TRIGGER USER`);
  }
}

describePg('PostgreSQL ledger schema and financial protections', () => {
  beforeAll(async () => {
    await raw(`CREATE SCHEMA ${SCHEMA}`);
    // Point the pool at the scratch schema before it is first created.
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.DATABASE_SEARCH_PATH = SCHEMA;
    setPool(null);

    const result = await migrate();
    // Derived from the migrations directory so the assertion follows the schema instead of
    // breaking every time a migration is added.
    const expected = readdirSync('server/postgres/migrations')
      .filter((file) => file.endsWith('.sql'))
      .sort();
    expect(result.applied).toEqual(expected);
    expect(expected.length).toBeGreaterThanOrEqual(4);

    // Every guard must be present before a single row is written.
    const protections = await assertProtections();
    expect(protections.ok).toBe(true);
    expect(protections.counts.triggers).toBe(REQUIRED_TRIGGERS.length);
    expect(protections.counts.tables).toBeGreaterThanOrEqual(46);
    expect(protections.counts.foreignKeys).toBeGreaterThan(50);

    await transaction(async (tx) => {
      const seeded = await seedReferenceData(tx);
      expect(seeded.roles).toBeGreaterThan(0);
      expect(seeded.permissions).toBeGreaterThan(0);

      fx.business = id('biz_');
      fx.branch = id('br_');
      fx.brand = id('brd_');
      fx.category = id('cat_');
      fx.supplier = id('sup_');
      fx.owner = id('usr_');
      fx.cashier = id('usr_');
      fx.cashier2 = id('usr_');
      fx.cashier3 = id('usr_');
      fx.product = id('prd_');
      fx.session = id('cs_');
      fx.sale = id('sal_');
      fx.saleItem = id('sit_');
      fx.payment = id('pay_');
      fx.journal = id('je_');
      fx.approval = id('apr_');
      fx.invite = id('inv_');
      fx.purchase = id('pur_');

      await tx.insert('businesses', { id: fx.business, name: 'Kilele PG Test', created_at: now() });
      await tx.insert('branches', {
        id: fx.branch,
        business_id: fx.business,
        name: 'Main branch',
        location: '',
      });
      await tx.insert('brands', { id: fx.brand, business_id: fx.business, name: 'Test brand' });
      await tx.insert('categories', { id: fx.category, business_id: fx.business, name: 'Sodas' });
      await tx.insert('suppliers', {
        id: fx.supplier,
        business_id: fx.business,
        name: 'Test supplier',
        created_at: now(),
      });
      await tx.insert('users', {
        id: fx.owner,
        business_id: fx.business,
        branch_id: fx.branch,
        role_id: 'super_admin',
        name: 'Owner',
        email: `owner.${SCHEMA}@example.co.ke`,
        password_hash: 'scrypt-v2:not-used-by-these-tests:0',
        created_at: now(),
      });
      await tx.insert('users', {
        id: fx.cashier,
        business_id: fx.business,
        branch_id: fx.branch,
        role_id: 'super_admin',
        name: 'Cashier',
        email: `cashier.${SCHEMA}@example.co.ke`,
        password_hash: 'scrypt-v2:not-used-by-these-tests:0',
        created_at: now(),
      });
      for (const [key, name] of [
        ['cashier2', 'Cashier Two'],
        ['cashier3', 'Cashier Three'],
      ] as Array<[string, string]>) {
        await tx.insert('users', {
          id: fx[key],
          business_id: fx.business,
          branch_id: fx.branch,
          role_id: 'super_admin',
          name,
          email: `${key}.${SCHEMA}@example.co.ke`,
          password_hash: 'scrypt-v2:not-used-by-these-tests:0',
          created_at: now(),
        });
      }
      await tx.insert('products', {
        id: fx.product,
        business_id: fx.business,
        name: 'Test Soda 500ml',
        brand_id: fx.brand,
        category_id: fx.category,
        sku: `SKU-${SCHEMA.slice(-6)}`,
        supplier_id: fx.supplier,
        cost_cents: 60,
        selling_cents: 100,
        tax_bps: 0,
        tax_mode: 'none',
        created_at: now(),
        updated_at: now(),
      });

      // A stock position must be opened at zero and then moved through the ledger.
      await tx.insert('inventory', {
        business_id: fx.business,
        branch_id: fx.branch,
        product_id: fx.product,
        quantity: 0,
        value_cents: 0,
        version: 0,
      });
      await tx.insert('cash_sessions', {
        id: fx.session,
        business_id: fx.business,
        branch_id: fx.branch,
        user_id: fx.cashier,
        register: 'Till 1',
        opening_cents: 0,
        opened_at: now(),
      });
      // Opening stock: 24 units at 100 cents = 2400.
      await tx.insert('inventory_movements', {
        id: id('mov_'),
        business_id: fx.business,
        branch_id: fx.branch,
        product_id: fx.product,
        user_id: fx.owner,
        kind: 'opening',
        quantity: 24,
        previous_qty: 0,
        new_qty: 24,
        value_delta_cents: 2400,
        previous_value_cents: 0,
        new_value_cents: 2400,
        reason: 'Opening balance',
        reference: 'OPEN-1',
        approval_status: 'authorised',
        created_at: now(),
      });

      // A complete, self-consistent sale so the integrity checker has real data to recompute.
      await tx.insert('sales', {
        id: fx.sale,
        ref: 'S-1',
        business_id: fx.business,
        branch_id: fx.branch,
        user_id: fx.cashier,
        session_id: fx.session,
        subtotal_cents: 200,
        discount_cents: 0,
        total_cents: 200,
        tax_cents: 0,
        cogs_cents: 120,
        created_at: now(),
      });
      await tx.insert('sale_items', {
        id: fx.saleItem,
        sale_id: fx.sale,
        business_id: fx.business,
        branch_id: fx.branch,
        product_id: fx.product,
        product_name: 'Test Soda 500ml',
        sku: 'SKU-1',
        brand_name: 'Test brand',
        category_name: 'Sodas',
        size: '500ml',
        quantity: 2,
        unit_price_cents: 100,
        unit_cost_cents: 60,
        price_type: 'retail',
        subtotal_cents: 200,
        discount_cents: 0,
        total_cents: 200,
        tax_cents: 0,
        tax_bps: 0,
        tax_mode: 'none',
        cogs_cents: 120,
      });
      await tx.insert('payments', {
        id: fx.payment,
        business_id: fx.business,
        branch_id: fx.branch,
        sale_id: fx.sale,
        session_id: fx.session,
        user_id: fx.cashier,
        method: 'Cash',
        amount_cents: 200,
        tendered_cents: 200,
        change_cents: 0,
        created_at: now(),
      });
      await tx.insert('inventory_movements', {
        id: id('mov_'),
        business_id: fx.business,
        branch_id: fx.branch,
        product_id: fx.product,
        user_id: fx.cashier,
        session_id: fx.session,
        kind: 'sale',
        quantity: -2,
        previous_qty: 24,
        new_qty: 22,
        value_delta_cents: -120,
        previous_value_cents: 2400,
        new_value_cents: 2280,
        reason: 'Sale S-1',
        reference: 'S-1',
        approval_status: 'authorised',
        created_at: now(),
      });
      await tx.insert('journal_entries', {
        id: fx.journal,
        business_id: fx.business,
        branch_id: fx.branch,
        user_id: fx.cashier,
        reference: 'S-1',
        description: 'Cash sale',
        created_at: now(),
      });
      await tx.insert('journal_lines', {
        id: id('jl_'),
        entry_id: fx.journal,
        business_id: fx.business,
        branch_id: fx.branch,
        account: 'Cash on hand',
        debit_cents: 200,
        credit_cents: 0,
      });
      await tx.insert('journal_lines', {
        id: id('jl_'),
        entry_id: fx.journal,
        business_id: fx.business,
        branch_id: fx.branch,
        account: 'Sales revenue',
        debit_cents: 0,
        credit_cents: 200,
      });
      await tx.insert('approval_requests', {
        id: fx.approval,
        ref: 'A-1',
        business_id: fx.business,
        branch_id: fx.branch,
        user_id: fx.cashier,
        kind: 'stock_receipt',
        entity: 'purchases',
        entity_id: 'pur_pending',
        reason: 'Receive stock',
        payload_json: JSON.stringify({ total_cents: 5000 }),
        created_at: now(),
      });
      await tx.insert('staff_invitations', {
        id: fx.invite,
        business_id: fx.business,
        branch_id: fx.branch,
        name: 'Invited Supervisor',
        email: `invite.${SCHEMA}@example.co.ke`,
        role_id: 'super_admin',
        token_hash: id('tok_'),
        invited_by: fx.owner,
        reason: 'New supervisor',
        created_at: now(),
        expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      });
      await tx.insert('purchases', {
        id: fx.purchase,
        ref: 'P-1',
        business_id: fx.business,
        branch_id: fx.branch,
        user_id: fx.owner,
        supplier_id: fx.supplier,
        supplier_name: 'Test supplier',
        total_cents: 5000,
        invoice_ref: 'INV-001',
        purchase_date: now(),
        payment_method: 'Bank',
        created_at: now(),
      });

      const actor = {
        id: fx.owner,
        business_id: fx.business,
        branch_id: fx.branch,
        name: 'Owner',
        email: `owner.${SCHEMA}@example.co.ke`,
        role_id: 'super_admin',
        must_change_password: 0,
        permissions: [] as string[],
      };
      await audit(
        tx,
        actor,
        'test.fixture',
        'businesses',
        fx.business,
        null,
        { name: 'Kilele PG Test' },
        'Fixture',
      );
    });
  }, 120_000);

  afterAll(async () => {
    await closePool();
    if (DATABASE_URL) await raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    delete process.env.DATABASE_SEARCH_PATH;
  });

  describe('migrations', () => {
    it('are recorded with checksums and are not re-applied', async () => {
      const again = await migrate();
      expect(again.applied).toEqual([]);
      // Derived from the migrations directory, so adding a migration cannot break this silently.
      expect(again.skipped.length).toBe(
        readdirSync('server/postgres/migrations').filter((file) => file.endsWith('.sql')).length,
      );
    });

    it('install every protection the SQLite ledger enforces', async () => {
      const report = await verifyProtections();
      expect(report.missing).toEqual([]);
      expect(report.ok).toBe(true);
    });
  });

  describe('inventory is a projection of the movement ledger', () => {
    it('rejects an opening position that is not zero', () =>
      rejected(
        () =>
          transaction((tx) =>
            tx.insert('inventory', {
              business_id: fx.business,
              branch_id: fx.branch,
              product_id: id('prd_missing'),
              quantity: 10,
              value_cents: 1000,
              version: 0,
            }),
          ),
        'Opening inventory must use a ledger movement',
      ));

    it('rejects a hand-written UPDATE of a stock position', () =>
      rejected(
        () =>
          transaction((tx) =>
            tx.exec('UPDATE inventory SET quantity = quantity + 1 WHERE product_id = ?', fx.product),
          ),
        'Inventory updates require a matching ledger movement',
      ));

    it('rejects deleting a stock position', () =>
      rejected(
        () => transaction((tx) => tx.exec('DELETE FROM inventory WHERE product_id = ?', fx.product)),
        'Inventory cannot be deleted',
      ));

    it('rejects a movement that does not follow the live position', () =>
      rejected(
        () =>
          transaction((tx) =>
            tx.insert('inventory_movements', {
              id: id('mov_'),
              business_id: fx.business,
              branch_id: fx.branch,
              product_id: fx.product,
              user_id: fx.owner,
              kind: 'adjustment',
              quantity: 5,
              previous_qty: 0, // stale: the position is at 22
              new_qty: 5,
              value_delta_cents: 500,
              previous_value_cents: 0,
              new_value_cents: 500,
              reason: 'Stale write',
              reference: 'STALE-1',
              approval_status: 'authorised',
              created_at: now(),
            }),
          ),
        'Stock changed; reload before posting',
      ));

    it('projects a valid movement onto the position and bumps the version', async () => {
      const before = await one<{ quantity: number; value_cents: number; version: number }>(
        getPool(),
        'SELECT quantity, value_cents, version FROM inventory WHERE product_id = ?',
        fx.product,
      );
      expect(before).toEqual({ quantity: 22, value_cents: 2280, version: 2 });

      await transaction((tx) =>
        tx.insert('inventory_movements', {
          id: id('mov_'),
          business_id: fx.business,
          branch_id: fx.branch,
          product_id: fx.product,
          user_id: fx.owner,
          kind: 'adjustment',
          quantity: 3,
          previous_qty: 22,
          new_qty: 25,
          value_delta_cents: 300,
          previous_value_cents: 2280,
          new_value_cents: 2580,
          reason: 'Stock count correction',
          reference: 'ADJ-1',
          approval_status: 'authorised',
          created_at: now(),
        }),
      );

      const after = await one<{ quantity: number; value_cents: number; version: number }>(
        getPool(),
        'SELECT quantity, value_cents, version FROM inventory WHERE product_id = ?',
        fx.product,
      );
      expect(after).toEqual({ quantity: 25, value_cents: 2580, version: 3 });
    });

    it('keeps the movement ledger immutable', () =>
      rejected(
        () =>
          transaction((tx) =>
            tx.exec('UPDATE inventory_movements SET reason = ? WHERE reference = ?', 'edited', 'ADJ-1'),
          ),
        'inventory_movements records are immutable; request a correction',
      ));

    it('blocks a second writer on the same stock row with SELECT ... FOR UPDATE', async () => {
      // The holder locks the position and keeps the transaction open.
      const holder = getPool();
      const holderClient = await holder.connect();
      const waiter = getPool();
      const waiterClient = await waiter.connect();
      try {
        await holderClient.query('BEGIN');
        await holderClient.query(translate('SELECT * FROM inventory WHERE product_id = ?') + ' FOR UPDATE', [
          fx.product,
        ]);

        await waiterClient.query('BEGIN');
        // 400 ms is far longer than this query takes when uncontended.
        await waiterClient.query("SET LOCAL statement_timeout = '400ms'");
        let code = '';
        try {
          await waiterClient.query(
            translate('SELECT * FROM inventory WHERE product_id = ?') + ' FOR UPDATE',
            [fx.product],
          );
        } catch (error) {
          code = (error as { code?: string }).code ?? '';
        }
        await waiterClient.query('ROLLBACK');
        expect(code).toBe('57014'); // query cancelled on statement timeout: it was blocked by the lock
        await holderClient.query('COMMIT');
      } finally {
        holderClient.release();
        waiterClient.release();
      }
    });
  });

  describe('financial records are immutable', () => {
    it('rejects updating a sale', () =>
      rejected(
        () =>
          transaction((tx) =>
            tx.exec('UPDATE sales SET total_cents = total_cents + 1 WHERE id = ?', fx.sale),
          ),
        'sales records are immutable; request a correction',
      ));

    it('rejects deleting a sale line', () =>
      rejected(
        () => transaction((tx) => tx.exec('DELETE FROM sale_items WHERE id = ?', fx.saleItem)),
        'sale_items records are immutable; request a correction',
      ));

    it('rejects updating the audit log', () =>
      rejected(
        () => transaction((tx) => tx.exec("UPDATE audit_logs SET reason = 'edited'")),
        'audit_logs records are immutable; request a correction',
      ));

    it('rejects deleting a journal line', () =>
      rejected(
        () => transaction((tx) => tx.exec('DELETE FROM journal_lines WHERE entry_id = ?', fx.journal)),
        'journal_lines records are immutable; request a correction',
      ));
  });

  describe('approvals preserve the original request', () => {
    it('rejects editing the request itself', () =>
      rejected(
        () =>
          transaction((tx) =>
            tx.exec('UPDATE approval_requests SET payload_json = ? WHERE id = ?', '{}', fx.approval),
          ),
        'Original approval requests are immutable',
      ));

    it('allows a decision, then freezes the request', async () => {
      await transaction((tx) =>
        tx.exec(
          'UPDATE approval_requests SET status = ?, reviewer_id = ?, review_reason = ?, reviewed_at = ? WHERE id = ?',
          'approved',
          fx.owner,
          'Verified delivery note',
          now(),
          fx.approval,
        ),
      );
      await rejected(
        () =>
          transaction((tx) =>
            tx.exec('UPDATE approval_requests SET review_reason = ? WHERE id = ?', 'rewritten', fx.approval),
          ),
        'A reviewed request cannot be changed',
      );
      await rejected(
        () => transaction((tx) => tx.exec('DELETE FROM approval_requests WHERE id = ?', fx.approval)),
        'Approval history cannot be deleted',
      );
    });
  });

  describe('cash sessions', () => {
    it('only allows closing a live session', async () => {
      const sessionId = id('cs_');
      await transaction((tx) =>
        tx.insert('cash_sessions', {
          id: sessionId,
          business_id: fx.business,
          branch_id: fx.branch,
          user_id: fx.cashier2,
          register: 'Till 9',
          opening_cents: 500,
          opened_at: now(),
        }),
      );
      await rejected(
        () =>
          transaction((tx) =>
            tx.exec('UPDATE cash_sessions SET register = ? WHERE id = ?', 'Till 10', sessionId),
          ),
        'Only closing a live session is allowed',
      );
      await rejected(
        () =>
          transaction((tx) => tx.exec('UPDATE cash_sessions SET opening_cents = 0 WHERE id = ?', sessionId)),
        'Only closing a live session is allowed',
      );
      // Closing is the one permitted update.
      await transaction((tx) =>
        tx.exec('UPDATE cash_sessions SET closed_at = ? WHERE id = ?', now(), sessionId),
      );
      await rejected(
        () =>
          transaction((tx) =>
            tx.exec('UPDATE cash_sessions SET closed_at = ? WHERE id = ?', now(), sessionId),
          ),
        'Only closing a live session is allowed',
      );
      await rejected(
        () => transaction((tx) => tx.exec('DELETE FROM cash_sessions WHERE id = ?', sessionId)),
        'Sessions cannot be deleted',
      );
    });

    it('allows one open session per user', () =>
      rejected(
        () =>
          transaction((tx) =>
            tx.insert('cash_sessions', {
              id: id('cs_'),
              business_id: fx.business,
              branch_id: fx.branch,
              user_id: fx.cashier, // the fixture session for this cashier is still open
              register: 'Till 2',
              opening_cents: 0,
              opened_at: now(),
            }),
          ),
        'one_open_session_per_user',
      ));

    it('allows one open session per register, matching names case- and space-insensitively', () =>
      rejected(
        () =>
          transaction((tx) =>
            tx.insert('cash_sessions', {
              id: id('cs_'),
              business_id: fx.business,
              branch_id: fx.branch,
              user_id: fx.cashier3,
              register: '  till 1 ',
              opening_cents: 0,
              opened_at: now(),
            }),
          ),
        'open_register_name_normalized',
      ));
  });

  describe('staff invitations', () => {
    it('freezes the terms that were sent', () =>
      rejected(
        () =>
          transaction((tx) =>
            tx.exec('UPDATE staff_invitations SET name = ? WHERE id = ?', 'Changed Name', fx.invite),
          ),
        'Invitation terms are immutable; revoke and invite again',
      ));

    it('allows revoking a pending invitation, then freezes it', async () => {
      await transaction((tx) =>
        tx.exec(
          'UPDATE staff_invitations SET status = ?, closed_at = ?, closed_reason = ? WHERE id = ?',
          'revoked',
          now(),
          'No longer joining',
          fx.invite,
        ),
      );
      await rejected(
        () =>
          transaction((tx) =>
            tx.exec("UPDATE staff_invitations SET status = 'pending' WHERE id = ?", fx.invite),
          ),
        'A closed invitation cannot change state',
      );
      await rejected(
        () => transaction((tx) => tx.exec('DELETE FROM staff_invitations WHERE id = ?', fx.invite)),
        'Invitations cannot be deleted',
      );
    });
  });

  describe('duplicate supplier invoices', () => {
    it('rejects a second active purchase for the same invoice, ignoring case and padding', () =>
      rejected(
        () =>
          transaction((tx) =>
            tx.insert('purchases', {
              id: id('pur_'),
              ref: 'P-2',
              business_id: fx.business,
              branch_id: fx.branch,
              user_id: fx.owner,
              supplier_id: fx.supplier,
              supplier_name: 'Test supplier',
              total_cents: 5000,
              invoice_ref: '  inv-001 ',
              purchase_date: now(),
              payment_method: 'Bank',
              created_at: now(),
            }),
          ),
        'This supplier invoice already has an active purchase',
      ));
  });

  describe('price changes require immutable history', () => {
    it('rejects a price change with no matching history row', () =>
      rejected(
        () =>
          transaction((tx) => tx.exec('UPDATE products SET selling_cents = 150 WHERE id = ?', fx.product)),
        'Price changes require a matching immutable price history',
      ));

    it('allows a non-pricing edit without history', async () => {
      const rows = await transaction((tx) =>
        tx.exec('UPDATE products SET notes = ?, version = version + 1 WHERE id = ?', 'Shelf A', fx.product),
      );
      expect(rows).toBe(1);
    });

    it('allows the change once the history row records exactly that transition', async () => {
      // priceSnapshot() in server/products.ts copies the six fields straight off the row, so a
      // NULL wholesale/promo price is recorded as JSON null - not as 0.
      const snapshot = (selling: number) =>
        JSON.stringify({
          cost_cents: 60,
          selling_cents: selling,
          wholesale_cents: null,
          promo_cents: null,
          tax_mode: 'none',
          tax_bps: 0,
        });
      const writeHistory = (previous: string, next: string) =>
        transaction((tx) =>
          tx.insert('price_history', {
            id: id('ph_'),
            business_id: fx.business,
            product_id: fx.product,
            user_id: fx.owner,
            previous_json: previous,
            next_json: next,
            reason: 'Supplier price increase',
            created_at: now(),
          }),
        );

      // A history row that says 0 where the column is NULL must NOT authorise the change:
      // the SQLite guard used `IS` (null-safe identity) and the port must be just as exact.
      await writeHistory(snapshot(100).replace(/null/g, '0'), snapshot(150).replace(/null/g, '0'));
      await rejected(
        () =>
          transaction((tx) => tx.exec('UPDATE products SET selling_cents = 150 WHERE id = ?', fx.product)),
        'Price changes require a matching immutable price history',
      );

      await writeHistory(snapshot(100), snapshot(150));
      const rows = await transaction((tx) =>
        tx.exec(
          'UPDATE products SET selling_cents = 150, updated_at = ?, version = version + 1 WHERE id = ?',
          now(),
          fx.product,
        ),
      );
      expect(rows).toBe(1);

      // Only the newest history row authorises a change, so the next edit needs its own row.
      await rejected(
        () =>
          transaction((tx) => tx.exec('UPDATE products SET selling_cents = 175 WHERE id = ?', fx.product)),
        'Price changes require a matching immutable price history',
      );

      // ...and the history itself can never be edited afterwards.
      await rejected(
        () =>
          transaction((tx) =>
            tx.exec("UPDATE price_history SET reason = 'edited' WHERE product_id = ?", fx.product),
          ),
        'price_history records are immutable; request a correction',
      );
    });
  });

  describe('case-insensitive email uniqueness', () => {
    it('rejects the same address in a different case', () =>
      rejected(
        () =>
          transaction((tx) =>
            tx.insert('users', {
              id: id('usr_'),
              business_id: fx.business,
              branch_id: fx.branch,
              role_id: 'super_admin',
              name: 'Impostor',
              email: `OWNER.${SCHEMA}@EXAMPLE.CO.KE`,
              password_hash: 'scrypt-v2:not-used:0',
              created_at: now(),
            }),
          ),
        'users_email_ci_unique',
      ));
  });

  describe('transactions', () => {
    it('rolls the whole financial unit back when any step fails', async () => {
      await expect(
        transaction(async (tx) => {
          await tx.insert('suppliers', {
            id: id('sup_'),
            business_id: fx.business,
            name: 'Rolled back supplier',
            created_at: now(),
          });
          throw new Error('card terminal timeout');
        }),
      ).rejects.toThrow('card terminal timeout');
      const found = await one(getPool(), "SELECT id FROM suppliers WHERE name = 'Rolled back supplier'");
      expect(found).toBeNull();
    });

    it('rolls back only the failed savepoint when a nested unit fails', async () => {
      const marker = id('sup_');
      await transaction(async (tx) => {
        await tx.insert('suppliers', {
          id: marker,
          business_id: fx.business,
          name: 'Outer supplier',
          created_at: now(),
        });
        await expect(
          transaction(async (inner) => {
            await inner.insert('suppliers', {
              id: id('sup_'),
              business_id: fx.business,
              name: 'Inner supplier',
              created_at: now(),
            });
            throw new Error('inner failure');
          }),
        ).rejects.toThrow('inner failure');
        // The outer transaction is still usable after the savepoint rollback.
        await tx.insert('suppliers', {
          id: id('sup_'),
          business_id: fx.business,
          name: 'After savepoint',
          created_at: now(),
        });
      });
      expect(await one(getPool(), 'SELECT id FROM suppliers WHERE id = ?', marker)).not.toBeNull();
      expect(await one(getPool(), "SELECT id FROM suppliers WHERE name = 'Inner supplier'")).toBeNull();
      expect(await one(getPool(), "SELECT id FROM suppliers WHERE name = 'After savepoint'")).not.toBeNull();
    });

    it('refuses to reuse a completed transaction', async () => {
      let captured: Tx | undefined;
      await transaction(async (inner) => {
        captured = inner;
      });
      expect(captured).toBeDefined();
      await expect(captured!.all('SELECT 1')).rejects.toThrow('Transaction has already completed');
    });
  });

  describe('query helpers', () => {
    it('rewrites ? placeholders to $n and ignores literals and comments', () => {
      expect(translate('SELECT * FROM t WHERE a = ? AND b = ?')).toBe(
        'SELECT * FROM t WHERE a = $1 AND b = $2',
      );
      expect(translate("SELECT '?' AS q, a FROM t WHERE b = ?")).toBe(
        "SELECT '?' AS q, a FROM t WHERE b = $1",
      );
      expect(translate('SELECT a FROM t -- where b = ?\nWHERE c = ?')).toBe(
        'SELECT a FROM t -- where b = ?\nWHERE c = $1',
      );
    });

    it('rejects SQLite-only syntax instead of silently changing behaviour', () => {
      expect(() => translate('INSERT OR REPLACE INTO sales (id) VALUES (?)')).toThrow(/INSERT OR REPLACE/);
      expect(() => translate('INSERT OR IGNORE INTO sales (id) VALUES (?)')).toThrow(
        /ON CONFLICT DO NOTHING/,
      );
      expect(() => translate('SELECT * FROM users WHERE email = ? COLLATE NOCASE')).toThrow(/COLLATE NOCASE/);
      expect(() => translate('SELECT json_group_array(id) FROM sales')).toThrow(/json_agg/);
      expect(() => translate('PRAGMA foreign_keys = ON')).toThrow(/PRAGMA/);
    });

    it('returns bigint aggregates as numbers, not strings', async () => {
      const total = await one<{ total: number }>(getPool(), 'SELECT SUM(total_cents) AS total FROM sales');
      expect(typeof total?.total).toBe('number');
      expect(total?.total).toBe(200);
    });
  });

  describe('ledger integrity check', () => {
    it('reports a consistent ledger as clean', async () => {
      const result = await integrity();
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.checks.ran).toContain('audit hash chain');
      expect(result.checks.pending.length).toBeGreaterThan(0); // coverage is stated, never implied
    });

    it('verifies the audit hash chain', async () => {
      expect(await verifyAudit()).toEqual([]);
    });

    it('detects inventory that no longer matches its ledger', async () => {
      await withoutTriggers('inventory', async () => {
        await exec(
          getPool(),
          'UPDATE inventory SET quantity = quantity + 5 WHERE product_id = ?',
          fx.product,
        );
      });
      const result = await integrity();
      expect(result.ok).toBe(false);
      expect(result.errors).toContain('Inventory balance/version does not match its movement ledger');

      await withoutTriggers('inventory', async () => {
        await exec(
          getPool(),
          'UPDATE inventory SET quantity = quantity - 5 WHERE product_id = ?',
          fx.product,
        );
      });
      expect((await integrity()).ok).toBe(true);
    });

    it('detects a sale header that no longer matches its items', async () => {
      await withoutTriggers('sale_items', async () => {
        await exec(
          getPool(),
          'UPDATE sale_items SET total_cents = total_cents + 1 WHERE id = ?',
          fx.saleItem,
        );
      });
      const result = await integrity();
      expect(result.errors).toContain('Sale header does not match recorded sale items');

      await withoutTriggers('sale_items', async () => {
        await exec(
          getPool(),
          'UPDATE sale_items SET total_cents = total_cents - 1 WHERE id = ?',
          fx.saleItem,
        );
      });
      expect((await integrity()).ok).toBe(true);
    });

    it('detects tendered cash that no longer matches the payment', async () => {
      await withoutTriggers('payments', async () => {
        await exec(getPool(), 'UPDATE payments SET change_cents = 1 WHERE id = ?', fx.payment);
      });
      const result = await integrity();
      expect(result.errors).toContain('Tendered cash/change does not match payment');
      // The tender total is unchanged, so the sale still reconciles: only the cash arithmetic fails.
      expect(result.errors).not.toContain('Sale tenders do not reconcile to sale and returns');

      await withoutTriggers('payments', async () => {
        await exec(getPool(), 'UPDATE payments SET change_cents = 0 WHERE id = ?', fx.payment);
      });
      expect((await integrity()).ok).toBe(true);
    });

    it('detects an unbalanced journal', async () => {
      await withoutTriggers('journal_lines', async () => {
        await exec(
          getPool(),
          "UPDATE journal_lines SET debit_cents = debit_cents + 1 WHERE entry_id = ? AND account = 'Cash on hand'",
          fx.journal,
        );
      });
      expect((await integrity()).errors).toContain('Unbalanced journals');

      await withoutTriggers('journal_lines', async () => {
        await exec(
          getPool(),
          "UPDATE journal_lines SET debit_cents = debit_cents - 1 WHERE entry_id = ? AND account = 'Cash on hand'",
          fx.journal,
        );
      });
      expect((await integrity()).ok).toBe(true);
    });

    it('detects a tampered audit row', async () => {
      await withoutTriggers('audit_logs', async () => {
        await exec(
          getPool(),
          "UPDATE audit_logs SET reason = 'tampered' WHERE seq = (SELECT MIN(seq) FROM audit_logs)",
        );
      });
      const errors = await verifyAudit();
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toMatch(/^Audit chain mismatch at \d+$/);

      await withoutTriggers('audit_logs', async () => {
        await exec(
          getPool(),
          "UPDATE audit_logs SET reason = 'Fixture' WHERE seq = (SELECT MIN(seq) FROM audit_logs)",
        );
      });
      expect(await verifyAudit()).toEqual([]);
    });

    it('detects a removed protection', async () => {
      await exec(getPool(), 'DROP TRIGGER inventory_cannot_delete ON inventory');
      const report = await verifyProtections();
      expect(report.ok).toBe(false);
      expect(report.missing).toContain('trigger inventory.inventory_cannot_delete');
      await expect(assertProtections()).rejects.toThrow(/inventory.inventory_cannot_delete/);

      await exec(
        getPool(),
        'CREATE TRIGGER inventory_cannot_delete BEFORE DELETE ON inventory FOR EACH ROW EXECUTE FUNCTION inventory_cannot_delete()',
      );
      expect((await verifyProtections()).ok).toBe(true);
    });
  });
});
