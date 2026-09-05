import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync, appendFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { fixture, addUser, saleInput } from './helpers.js';
import { createApp } from '../server/app.js';
import { createDb, bootstrap, actorFor, hashPassword } from '../server/db.js';
import { guardEnvironment } from '../server/environment.js';
import { backupDatabase, restoreBackup } from '../server/backup-engine.js';
import { createCorrectionRequest, reviewRequest } from '../server/approvals.js';
import { createSale } from '../server/sales.js';
import { saveSupplier, createPurchase, recordSupplierPayment } from '../server/inventory.js';
import { sessionTotals } from '../server/stock-engine.js';
import { saveUser } from '../server/management.js';
import {
  one,
  all,
  insert,
  id,
  now,
  scope,
  kenyaDate,
  integrity,
  type DB,
  type Actor,
} from '../server/core.js';
let db: DB;
const directories: string[] = [];
afterEach(() => {
  db?.close();
  vi.useRealTimers();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const narrative = {
  explanation: 'Synthetic accounting test; the original record was inspected.',
  requested_change: 'Post the specified linked adjustment without rewriting the original.',
};
const login = async (app: ReturnType<typeof createApp>, email: string) => {
  const agent = request.agent(app);
  const result = await agent.post('/api/auth/login').send({ email, password: 'test-password-strong' });
  expect(result.status).toBe(200);
  return { agent, csrf: result.body.csrf };
};
const register = (a: Actor, opening = 100000) => {
  const sid = id();
  insert(db, 'cash_sessions', {
    id: sid,
    ...scope(a),
    user_id: a.id,
    register: id(),
    opening_cents: opening,
    opened_at: now(),
  });
  return sid;
};
const pdfText = (buffer: Buffer) => {
  let text = '';
  const source = buffer.toString('latin1');
  for (const match of source.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      const content = inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1');
      text += [...content.matchAll(/<([0-9a-fA-F]+)>/g)]
        .map((m) => Buffer.from(m[1], 'hex').toString('latin1'))
        .join('');
    } catch {
      /* Non-text / uncompressed streams. */
    }
  }
  return text;
};
describe('Security, recoverability and financial edge cases', () => {
  it('permanently blocks preview database promotion and preview auth on operational data', () => {
    db = createDb();
    guardEnvironment(db, true, false);
    bootstrap(db, { name: 'Preview Test', email: 'renamed@example.test', password: 'test-password-strong' });
    expect(() => guardEnvironment(db, false, true)).toThrow(/preview provenance/);
    expect(() => db.prepare('DELETE FROM environment_markers').run()).toThrow(/immutable/);
    expect(() => createApp(db, { production: true, origin: 'https://shop.example.test' })).toThrow(
      /preview provenance/,
    );
    db.close();
    db = fixture().db;
    expect(() => guardEnvironment(db, true, false)).toThrow(/operational/);
  });
  it('creates database and WAL files with owner-only permissions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kilele-permissions-'));
    directories.push(directory);
    const file = join(directory, 'private.sqlite');
    db = createDb(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    for (const sidecar of [file + '-wal', file + '-shm'])
      if (existsSync(sidecar)) expect(statSync(sidecar).mode & 0o777).toBe(0o600);
  });
  it('rejects fractional minor units and quantities even through direct future database code', () => {
    const f = fixture();
    db = f.db;
    expect(() =>
      db.prepare('UPDATE businesses SET variance_threshold_cents=0.5 WHERE id=?').run(f.a.business_id),
    ).toThrow(/Integer/);
    expect(() => db.prepare('UPDATE products SET min_stock=1.5 WHERE id=?').run(f.p.id)).toThrow(/Integer/);
    expect(integrity(db).ok).toBe(true);
  });
  it('creates a consistent backup, validates a fresh-path restore, and refuses tampering or overwrite', async () => {
    const f = fixture();
    db = f.db;
    const dir = mkdtempSync(join(tmpdir(), 'kilele-backup-'));
    directories.push(dir);
    const source = join(dir, 'source.sqlite'),
      backup = join(dir, 'backup.sqlite'),
      restored = join(dir, 'restored.sqlite');
    await db.backup(source);
    const result = await backupDatabase(source, backup);
    expect(result.verified).toBe(true);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    const check = restoreBackup(backup, restored);
    expect(check.ok).toBe(true);
    expect(check.auditEvents).toBe(integrity(db).auditEvents);
    expect(() => restoreBackup(backup, restored)).toThrow(/empty/);
    await expect(backupDatabase(source, backup)).rejects.toThrow(/overwrite/);
    appendFileSync(backup, 'tampering');
    expect(() => restoreBackup(backup, join(dir, 'bad.sqlite'))).toThrow(/checksum/);
  });
  it('replays interrupted checkouts once, scopes recovery to their owner, and makes cancellation race-safe', async () => {
    const f = fixture();
    db = f.db;
    const cashier = addUser(db, f.a, 'cashier');
    const app = createApp(db),
      owner = await login(app, f.a.email),
      other = await login(app, cashier.email);
    const input = saleInput(f.p, f.sessionId),
      key = id();
    const submit = () =>
      owner.agent.post('/api/sales').set('X-CSRF-Token', owner.csrf).set('Idempotency-Key', key).send(input);
    const first = await submit(),
      retry = await submit();
    expect(first.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);
    expect(all(db, 'SELECT * FROM sales')).toHaveLength(1);
    expect((await owner.agent.get('/api/operations/' + key)).body.result.id).toBe(first.body.id);
    expect((await other.agent.get('/api/operations/' + key)).body.state).toBe('not_found');
    const cancelPosted = await owner.agent
      .post(`/api/operations/${key}/cancel`)
      .set('X-CSRF-Token', owner.csrf)
      .set('Idempotency-Key', id())
      .send({ original: input, reason: 'Verify original outcome before cancelling' });
    expect(cancelPosted.body.state).toBe('posted');
    const unpostedKey = id(),
      unposted = { ...input, payments: [{ method: 'Cash', amount: '300' }] };
    const cancel = await owner.agent
      .post(`/api/operations/${unpostedKey}/cancel`)
      .set('X-CSRF-Token', owner.csrf)
      .set('Idempotency-Key', id())
      .send({ original: unposted, reason: 'Customer left before the software submission completed' });
    expect(cancel.body.state).toBe('cancelled');
    const late = await owner.agent
      .post('/api/sales')
      .set('X-CSRF-Token', owner.csrf)
      .set('Idempotency-Key', unpostedKey)
      .send(unposted);
    expect(late.body.code).toBe('SUBMISSION_CANCELLED');
    expect(all(db, 'SELECT * FROM sales')).toHaveLength(1);
    expect(integrity(db).ok).toBe(true);
  });
  it('enforces cashier and accountant restrictions, hides buying costs and rejects access to another tenant', async () => {
    const f = fixture();
    db = f.db;
    const cashier = addUser(db, f.a, 'cashier'),
      accountant = addUser(db, f.a, 'accountant');
    db.transaction(() =>
      saveUser(
        db,
        f.a,
        {
          name: accountant.name,
          email: accountant.email,
          role_id: 'accountant',
          active: true,
          reports_access: false,
          reason: 'Restrict financial report access for test',
        },
        accountant.id,
      ),
    )();
    const sale = db.transaction(() => createSale(db, f.a, saleInput(f.p, f.sessionId)))();
    const business = id(),
      branch = id(),
      uid = id();
    insert(db, 'businesses', { id: business, name: 'Second synthetic tenant', created_at: now() });
    insert(db, 'branches', { id: branch, business_id: business, name: 'Other branch' });
    insert(db, 'users', {
      id: uid,
      business_id: business,
      branch_id: branch,
      role_id: 'admin',
      name: 'Other admin',
      email: 'other@test.co.ke',
      password_hash: hashPassword('test-password-strong'),
      created_at: now(),
    });
    const app = createApp(db),
      c = await login(app, cashier.email),
      acc = await login(app, accountant.email),
      other = await login(app, 'other@test.co.ke');
    const products = (await c.agent.get('/api/products')).body.products,
      p = products.find((p: any) => p.id === f.p.id);
    expect(p.cost_configured).toBe(1);
    expect(p).not.toHaveProperty('cost_cents');
    expect(p).not.toHaveProperty('stock_value_cents');
    for (const route of [
      '/api/staff',
      '/api/audit',
      '/api/settings',
      '/api/reports/sales',
      '/api/sales/' + sale.id,
    ])
      expect((await c.agent.get(route)).status).toBe(403);
    expect((await acc.agent.get('/api/reports/sales')).status).toBe(403);
    expect((await acc.agent.get('/api/reports/inventory')).status).toBe(200);
    expect(
      (
        await acc.agent
          .post('/api/inventory/opening')
          .set('X-CSRF-Token', acc.csrf)
          .set('Idempotency-Key', id())
          .send({ product_id: f.p.id, quantity: 1, reason: 'Not permitted' })
      ).status,
    ).toBe(403);
    expect((await other.agent.get('/api/sales/' + sale.id)).status).toBe(404);
    expect((await other.agent.get('/api/products')).body.products).toHaveLength(0);
    expect(actorFor(db, accountant.id)?.permissions).not.toContain('staff.write');
  });
  it('validates file signatures, ownership, purpose permissions, private access and size limits', async () => {
    const f = fixture();
    db = f.db;
    const cashier = addUser(db, f.a, 'cashier'),
      app = createApp(db),
      owner = await login(app, f.a.email),
      c = await login(app, cashier.email);
    const data =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKxkAAAAASUVORK5CYII=';
    const upload = (body: any) =>
      owner.agent
        .post('/api/documents')
        .set('X-CSRF-Token', owner.csrf)
        .set('Idempotency-Key', id())
        .send(body);
    const privateDoc = await upload({ name: 'expense.png', mime: 'image/png', purpose: 'expense', data });
    expect(privateDoc.status).toBe(201);
    expect((await request(app).get(privateDoc.body.url)).status).toBe(401);
    expect((await c.agent.get(privateDoc.body.url)).status).toBe(403);
    expect((await owner.agent.get(privateDoc.body.url)).headers['content-security-policy']).toContain(
      'sandbox',
    );
    const image = await upload({ name: 'product.png', mime: 'image/png', purpose: 'product', data });
    expect((await c.agent.get(image.body.url)).status).toBe(200);
    expect(
      (
        await upload({
          name: 'fake.png',
          mime: 'image/png',
          purpose: 'expense',
          data: Buffer.from('<script>evil()</script>').toString('base64'),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await upload({
          name: 'huge.pdf',
          mime: 'application/pdf',
          purpose: 'expense',
          data: 'A'.repeat(4_000_001),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await c.agent
          .post('/api/documents')
          .set('X-CSRF-Token', c.csrf)
          .set('Idempotency-Key', id())
          .send({ name: 'no.png', mime: 'image/png', purpose: 'expense', data })
      ).status,
    ).toBe(403);
  });
  it('requires correction narratives and supports independent clarification through authenticated HTTP', async () => {
    const f = fixture();
    db = f.db;
    const reviewer = addUser(db, f.a, 'admin'),
      app = createApp(db),
      owner = await login(app, f.a.email),
      admin = await login(app, reviewer.email);
    const missing = await owner.agent
      .post('/api/approvals')
      .set('X-CSRF-Token', owner.csrf)
      .set('Idempotency-Key', id())
      .send({ kind: 'other', reason: 'Missing narrative input' });
    expect(missing.status).toBe(400);
    const created = await owner.agent
      .post('/api/approvals')
      .set('X-CSRF-Token', owner.csrf)
      .set('Idempotency-Key', id())
      .send({ kind: 'other', reason: 'Review this synthetic control note', ...narrative });
    expect(created.status).toBe(201);
    const rid = created.body.id,
      original = one(db, 'SELECT original_json,payload_json FROM approval_requests WHERE id=?', rid);
    const review = await admin.agent
      .post(`/api/approvals/${rid}/review`)
      .set('X-CSRF-Token', admin.csrf)
      .set('Idempotency-Key', id())
      .send({ action: 'clarify', reason: 'Please describe the missing supporting context' });
    expect(review.status).toBe(200);
    expect(
      (
        await admin.agent
          .post(`/api/approvals/${rid}/reply`)
          .set('X-CSRF-Token', admin.csrf)
          .set('Idempotency-Key', id())
          .send({ reason: 'Not my request to clarify' })
      ).status,
    ).toBe(403);
    expect(
      (
        await owner.agent
          .post(`/api/approvals/${rid}/reply`)
          .set('X-CSRF-Token', owner.csrf)
          .set('Idempotency-Key', id())
          .send({ reason: 'The supporting context has now been supplied' })
      ).status,
    ).toBe(200);
    expect(one(db, 'SELECT status FROM approval_requests WHERE id=?', rid)!.status).toBe('pending');
    expect(one(db, 'SELECT original_json,payload_json FROM approval_requests WHERE id=?', rid)).toEqual(
      original,
    );
    expect(all(db, 'SELECT * FROM approval_events WHERE request_id=?', rid)).toHaveLength(3);
  });
  it('returns purchases at current WAC and explicitly accounts for the valuation difference', () => {
    const f = fixture();
    db = f.db;
    const reviewer = addUser(db, f.a, 'admin'),
      supplier = saveSupplier(db, f.a, { name: 'Synthetic supplier', reason: 'Test supplier setup' });
    const purchase = db.transaction(() =>
      createPurchase(db, f.a, {
        supplier_id: supplier.id,
        invoice_ref: 'SYNTH-WAC',
        purchase_date: kenyaDate(),
        payment_method: 'Credit',
        items: [{ product_id: f.p.id, quantity: 10, cost: '150' }],
        reason: 'Synthetic differently priced receipt',
      }),
    )();
    const r = createCorrectionRequest(db, f.a, {
      kind: 'purchase_reversal',
      entity_id: purchase.id,
      reason: 'Supplier accepted return of complete delivery',
      ...narrative,
    });
    db.transaction(() =>
      reviewRequest(db, reviewer, r.id, {
        action: 'approve',
        reason: 'Supplier return quantities and credit note checked',
      }),
    )();
    expect(one(db, 'SELECT quantity,value_cents FROM inventory WHERE product_id=?', f.p.id)).toEqual({
      quantity: 20,
      value_cents: 233333,
    });
    expect(one(db, 'SELECT total_cents FROM purchases WHERE id=?', purchase.id)!.total_cents).toBe(150000);
    expect(one(db, 'SELECT inventory_cents FROM purchase_reversals')!.inventory_cents).toBe(116667);
    expect(integrity(db).ok).toBe(true);
  });
  it('reverses supplier payments into the reviewer’s live drawer without rewriting the original drawer', () => {
    const f = fixture();
    db = f.db;
    const reviewer = addUser(db, f.a, 'admin'),
      sid = register(reviewer),
      supplier = saveSupplier(db, f.a, { name: 'Synthetic supplier', reason: 'Test payment reversal' });
    const purchase = db.transaction(() =>
      createPurchase(db, f.a, {
        supplier_id: supplier.id,
        invoice_ref: 'SYNTH-PAY',
        purchase_date: kenyaDate(),
        payment_method: 'Credit',
        items: [{ product_id: f.p.id, quantity: 1, cost: '100' }],
        reason: 'Test supplier delivery',
      }),
    )();
    const payment = db.transaction(() =>
      recordSupplierPayment(db, f.a, one(db, 'SELECT * FROM purchases WHERE id=?', purchase.id)!, {
        amount: '70',
        method: 'Cash',
        reference: 'SYNTH-CASH',
      }),
    )();
    const r = createCorrectionRequest(db, f.a, {
      kind: 'supplier_payment_reversal',
      entity_id: payment.id,
      reason: 'Supplier returned the incorrect cash settlement',
      ...narrative,
    });
    db.transaction(() =>
      reviewRequest(db, reviewer, r.id, {
        action: 'approve',
        reason: 'Returned cash counted into my live register',
      }),
    )();
    expect(sessionTotals(db, f.a, f.sessionId).expected_cents).toBe(3000);
    expect(sessionTotals(db, reviewer, sid).expected_cents).toBe(107000);
    expect(one(db, 'SELECT amount_cents FROM supplier_payments WHERE id=?', payment.id)!.amount_cents).toBe(
      7000,
    );
    expect(integrity(db).ok).toBe(true);
  });
  it('applies approved price changes with a linked price history, while rejecting stale supplier changes', () => {
    const f = fixture();
    db = f.db;
    const operator = addUser(db, f.a, 'accountant');
    const price = createCorrectionRequest(db, operator, {
      kind: 'price_change',
      entity_id: f.p.id,
      reason: 'Request reviewed current selling price',
      ...narrative,
      payload: {
        version: f.p.version,
        cost: '100',
        selling: '160',
        wholesale: '140',
        promo: null,
        tax_mode: 'none',
        tax_bps: 0,
      },
    });
    db.transaction(() =>
      reviewRequest(db, f.a, price.id, {
        action: 'approve',
        reason: 'Owner confirmed manually chosen test price',
      }),
    )();
    expect(one(db, 'SELECT selling_cents FROM products WHERE id=?', f.p.id)!.selling_cents).toBe(16000);
    expect(one(db, 'SELECT approval_id FROM price_history ORDER BY rowid DESC LIMIT 1')!.approval_id).toBe(
      price.id,
    );
    const supplier = saveSupplier(db, f.a, {
      name: 'Original synthetic supplier',
      reason: 'Set up supplier',
    });
    const r = createCorrectionRequest(db, operator, {
      kind: 'supplier_change',
      entity_id: supplier.id,
      reason: 'Update supplier contact record',
      ...narrative,
      payload: { name: 'Requested supplier name' },
    });
    saveSupplier(
      db,
      f.a,
      { name: 'More recent supplier name', reason: 'Owner verified a newer name' },
      supplier.id,
    );
    expect(() =>
      db.transaction(() =>
        reviewRequest(db, f.a, r.id, { action: 'approve', reason: 'Attempt stale supplier update' }),
      )(),
    ).toThrow(/changed/);
    expect(one(db, 'SELECT status FROM approval_requests WHERE id=?', r.id)!.status).toBe('pending');
    expect(integrity(db).ok).toBe(true);
  });
  it('counts refunds posted today against older sales in today’s collections and prints historical receipt values', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-04T10:00:00Z'));
    const f = fixture();
    db = f.db;
    const reviewer = addUser(db, f.a, 'admin');
    register(reviewer);
    const sale = db.transaction(() => createSale(db, f.a, saleInput(f.p, f.sessionId)))();
    vi.setSystemTime(new Date('2026-09-05T10:00:00Z'));
    const r = createCorrectionRequest(db, f.a, {
      kind: 'sale_void',
      entity_id: sale.id,
      reason: 'Return posted on the next business day',
      ...narrative,
    });
    db.transaction(() =>
      reviewRequest(db, reviewer, r.id, {
        action: 'approve',
        reason: 'Returned products and original payment verified',
      }),
    )();
    const app = createApp(db),
      owner = await login(app, f.a.email),
      list = await owner.agent.get('/api/sales');
    expect(list.body.today.transactions).toBe(0);
    expect(list.body.today.net_collections_cents).toBe(-30000);
    const pdf = await owner.agent
      .get(`/api/sales/${sale.id}/receipt`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(pdf.headers['content-type']).toContain('application/pdf');
    const text = pdfText(pdf.body);
    expect(text).toContain(sale.ref);
    expect(text).toContain('300.00');
    expect(text).toContain('not an eTIMS');
  });
});
