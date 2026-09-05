import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import { scryptSync, randomBytes } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { fixture, addUser, saleInput } from './helpers.js';
import { createApp } from '../server/app.js';
import { one, all, insert, id, kenyaDate, integrity, type DB, type Actor } from '../server/core.js';
import { actorFor } from '../server/db.js';
import { createSale } from '../server/sales.js';
import { getReport, csvCell, REPORTS } from '../server/reports.js';
let db: DB;
afterEach(() => {
  db?.close();
  vi.useRealTimers();
});
const auth = async (app: ReturnType<typeof createApp>, actor: Actor) => {
  const agent = request.agent(app);
  const r = await agent
    .post('/api/auth/login')
    .send({ email: actor.email, password: 'test-password-strong' });
  expect(r.status).toBe(200);
  return { agent, csrf: r.body.csrf };
};
const post = (user: Awaited<ReturnType<typeof auth>>, path: string, body: object, key = id()) =>
  user.agent
    .post('/api' + path)
    .set('X-CSRF-Token', user.csrf)
    .set('Idempotency-Key', key)
    .send(body);
const narrative = {
  reason: 'Synthetic correction after original inspection',
  explanation: 'The original and physical evidence have been checked in this isolated test',
  requested_change: 'Append the requested correction; preserve the original record',
};
const pdfParser = (res: any, callback: (e: Error | null, value: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (b: Buffer) => chunks.push(b));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};
const pdfText = (pdf: Buffer) => {
  let text = '';
  for (const m of pdf.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g))
    try {
      const part = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
      text += [...part.matchAll(/<([0-9a-f]+)>/gi)]
        .map((h) => Buffer.from(h[1], 'hex').toString('latin1'))
        .join('');
    } catch {
      /* Non-text stream. */
    }
  return text;
};
describe('Authenticated accountant workflows and adverse cases', () => {
  it('executes all four critical chains as accountant and independent admin using HTTP', async () => {
    const f = fixture();
    db = f.db;
    const staff = addUser(db, f.a, 'accountant'),
      app = createApp(db),
      owner = await auth(app, f.a),
      operator = await auth(app, staff);
    const opened = await post(operator, '/sessions', {
      register: 'Accountant API register',
      opening: '1000',
    });
    expect(opened.status).toBe(201);
    const session = opened.body.session.id;
    const sale = await post(operator, '/sales', saleInput(f.p, session));
    expect(sale.status).toBe(201);
    expect(one(db, 'SELECT quantity FROM inventory WHERE product_id=?', f.p.id)!.quantity).toBe(18);
    const expense = await post(operator, '/expenses', {
      category: 'Transport',
      amount: '50',
      expense_date: kenyaDate(),
      method: 'Cash',
      description: 'Synthetic actual transport receipt',
    });
    expect(expense.status).toBe(201);
    const supplier = await post(owner, '/suppliers', {
      name: 'Synthetic controlled supplier',
      reason: 'Isolated API supplier setup',
    });
    const purchase = await post(operator, '/purchases', {
      supplier_id: supplier.body.id,
      invoice_ref: 'API-REAL-REFERENCE',
      purchase_date: kenyaDate(),
      payment_method: 'Credit',
      items: [{ product_id: f.p.id, quantity: 5, cost: '100' }],
      reason: 'Receiving documented for independent review',
    });
    expect(purchase.body.status).toBe('pending');
    expect(one(db, 'SELECT quantity FROM inventory WHERE product_id=?', f.p.id)!.quantity).toBe(18);
    expect(
      (
        await post(operator, `/approvals/${purchase.body.request_id}/review`, {
          action: 'approve',
          reason: 'Forbidden self review',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post(owner, `/approvals/${purchase.body.request_id}/review`, {
          action: 'approve',
          reason: 'Independent delivery note checked',
        })
      ).status,
    ).toBe(200);
    const waste = await post(operator, '/inventory/requests', {
      product_id: f.p.id,
      kind: 'wastage',
      quantity: 1,
      reason: 'One test unit was damaged',
      explanation: 'The physical damaged unit is separately recorded',
    });
    expect(waste.status).toBe(201);
    expect(
      (
        await post(owner, `/approvals/${waste.body.id}/review`, {
          action: 'approve',
          reason: 'Independently inspected loss',
        })
      ).status,
    ).toBe(200);
    const count = await post(operator, '/inventory/requests', {
      product_id: f.p.id,
      kind: 'stock_count',
      quantity: 20,
      reason: 'Witnessed physical count',
      explanation: 'Two fewer units than the expected balance',
    });
    expect(count.status).toBe(201);
    expect(
      (
        await post(owner, `/approvals/${count.body.id}/review`, {
          action: 'approve',
          reason: 'Count independently witnessed',
        })
      ).status,
    ).toBe(200);
    const closing = await post(operator, `/sessions/${session}/close`, {
      actual: '1040',
      explanation: 'Count is ten shillings below expected, for review',
    });
    expect(closing.status).toBe(201);
    const frozen = one(db, 'SELECT * FROM reconciliations WHERE id=?', closing.body.id)!;
    expect(frozen.expected_cents).toBe(105000);
    expect(
      (
        await post(owner, `/approvals/${closing.body.request_id}/review`, {
          action: 'approve',
          reason: 'Cash discrepancy independently reviewed',
        })
      ).status,
    ).toBe(200);
    const correction = await post(operator, '/approvals', {
      ...narrative,
      kind: 'expense_correction',
      entity_id: expense.body.id,
      payload: {
        replacement: {
          category: 'Transport',
          amount: '40',
          expense_date: kenyaDate(),
          method: 'Cash',
          description: 'Correct verified receipt value',
        },
      },
    });
    expect(correction.status).toBe(201);
    expect(
      (
        await post(owner, `/approvals/${correction.body.id}/review`, {
          action: 'approve',
          reason: 'Original and corrected receipt independently confirmed',
        })
      ).status,
    ).toBe(200);
    const detail = (await operator.agent.get(`/api/sales/${sale.body.id}`)).body;
    const returned = await post(operator, '/approvals', {
      ...narrative,
      kind: 'sale_return',
      entity_id: sale.body.id,
      payload: { items: [{ sale_item_id: detail.items[0].id, quantity: 1 }] },
    });
    expect(returned.status).toBe(201);
    expect(
      (
        await post(owner, `/approvals/${returned.body.id}/review`, {
          action: 'approve',
          reason: 'Returned unit and original payment verified',
        })
      ).status,
    ).toBe(200);
    expect(one(db, 'SELECT * FROM reconciliations WHERE id=?', closing.body.id)).toEqual(frozen);
    expect(one(db, 'SELECT amount_cents FROM expenses WHERE id=?', expense.body.id)!.amount_cents).toBe(5000);
    expect(one(db, 'SELECT total_cents FROM sales WHERE id=?', sale.body.id)!.total_cents).toBe(30000);
    const payments = await operator.agent.get('/api/reports/payments');
    expect(payments.status).toBe(200);
    expect(new Set(payments.body.rows.map((r: any) => r.source))).toEqual(
      new Set(['sale', 'expense', 'adjustment']),
    );
    const staffMetrics = (await owner.agent.get('/api/analytics/staff')).body.staff.find(
      (r: any) => r.id === staff.id,
    );
    expect(staffMetrics.correction_requests).toBe(2);
    expect(staffMetrics.purchase_entries).toBe(1);
    expect(staffMetrics.stock_requests).toBe(3);
    expect(staffMetrics.expenses_cents).toBe(5000);
    expect(integrity(db).ok).toBe(true);
    for (const [type, definition] of Object.entries(REPORTS)) {
      const authorised = actorFor(db, staff.id)!.permissions.includes(definition.permission);
      for (const format of ['json', 'csv', 'pdf']) {
        const result = await operator.agent.get(`/api/reports/${type}?format=${format}`).buffer(true);
        expect(result.status, `${type} ${format}`).toBe(authorised ? 200 : 403);
      }
    }
  });
  it('denies accountant administrator capabilities and all destructive or historical write routes at API level', async () => {
    const f = fixture();
    db = f.db;
    const staff = addUser(db, f.a, 'accountant'),
      operator = await auth(createApp(db), staff);
    const before = one(db, 'SELECT quantity,value_cents FROM inventory WHERE product_id=?', f.p.id);
    for (const path of [
      '/products',
      '/products/prices',
      '/suppliers',
      '/inventory/opening',
      '/staff',
      `/staff/${f.a.id}/reset-password`,
      `/approvals/${id()}/review`,
    ])
      expect((await post(operator, path, {})).status, path).toBe(403);
    expect(
      (
        await operator.agent
          .patch('/api/settings')
          .set('X-CSRF-Token', operator.csrf)
          .set('Idempotency-Key', id())
          .send({ name: 'Override' })
      ).status,
    ).toBe(403);
    for (const table of [
      'sales',
      'expenses',
      'purchases',
      'payments',
      'inventory',
      'audit',
      'journal',
      'approvals',
    ]) {
      expect(
        (await operator.agent.delete(`/api/${table}/${id()}`).set('X-CSRF-Token', operator.csrf)).status,
      ).toBe(404);
      if (table !== 'approvals')
        expect(
          (
            await operator.agent
              .patch(`/api/${table}/${id()}`)
              .set('X-CSRF-Token', operator.csrf)
              .set('Idempotency-Key', id())
              .send({ amount_cents: 0, quantity: 900 })
          ).status,
        ).toBe(404);
    }
    for (const path of [
      '/api/audit',
      '/api/staff',
      '/api/settings',
      '/api/reports/audit',
      '/api/reports/staff',
      '/api/integrity',
    ])
      expect((await operator.agent.get(path)).status, path).toBe(403);
    expect(one(db, 'SELECT quantity,value_cents FROM inventory WHERE product_id=?', f.p.id)).toEqual(before);
    expect(integrity(db).ok).toBe(true);
  });
  it('blocks forged totals, body scopes, privileges, SQL injection and mismatched origins without ledger effects', async () => {
    const f = fixture();
    db = f.db;
    const app = createApp(db),
      owner = await auth(app, f.a),
      input = saleInput(f.p, f.sessionId);
    for (const changed of [
      { ...input, business_id: id() },
      { ...input, role_id: 'super_admin' },
      { ...input, expected_total: '0.01' },
      { ...input, items: [{ ...input.items[0], quantity: 0.1 }] },
      { ...input, items: [{ ...input.items[0], unit_price_cents: 1 }] },
      { ...input, age_confirmed: false },
    ])
      expect((await post(owner, '/sales', changed)).status).toBe(
        changed.expected_total === '0.01' ? 409 : 400,
      );
    expect((await owner.agent.post('/api/sales').set('Idempotency-Key', id()).send(input)).status).toBe(403);
    expect((await post(owner, '/sales', input).set('Origin', 'https://attacker.invalid')).status).toBe(403);
    expect((await post(owner, '/sales', input).set('Sec-Fetch-Site', 'cross-site')).status).toBe(403);
    const literal = "x'); DROP TABLE sales;--";
    expect((await owner.agent.get('/api/reports/sales').query({ product: literal })).body.count).toBe(0);
    expect((await owner.agent.get('/api/sales/' + encodeURIComponent(literal))).status).toBe(404);
    expect((await request(app).post('/api/auth/login').send({ email: literal, password: 'x' })).status).toBe(
      400,
    );
    expect(all(db, 'SELECT * FROM sales')).toHaveLength(0);
    expect(
      (
        await post(owner, '/approvals', {
          ...narrative,
          kind: 'other',
          reviewer_id: f.a.id,
          status: 'approved',
        })
      ).status,
    ).toBe(400);
    expect(integrity(db).ok).toBe(true);
  });
  it('rolls back every sale effect on a late journal failure and safely retries its original key', async () => {
    const f = fixture();
    db = f.db;
    const owner = await auth(createApp(db), f.a),
      before = {
        stock: one(db, 'SELECT * FROM inventory WHERE product_id=?', f.p.id),
        audit: all(db, 'SELECT * FROM audit_logs').length,
      },
      key = id();
    db.exec(
      "CREATE TRIGGER synthetic_failure BEFORE INSERT ON journal_lines WHEN NEW.account='Cost of goods sold' BEGIN SELECT RAISE(ABORT,'Simulated late accounting failure'); END;",
    );
    expect((await post(owner, '/sales', saleInput(f.p, f.sessionId), key)).status).toBe(409);
    expect(all(db, 'SELECT * FROM sales')).toHaveLength(0);
    expect(all(db, 'SELECT * FROM payments')).toHaveLength(0);
    expect(one(db, 'SELECT * FROM inventory WHERE product_id=?', f.p.id)).toEqual(before.stock);
    expect(all(db, 'SELECT * FROM audit_logs')).toHaveLength(before.audit);
    expect(one(db, 'SELECT * FROM idempotency_keys WHERE key=?', key)).toBeUndefined();
    db.exec('DROP TRIGGER synthetic_failure');
    const [first, second] = await Promise.all([
      post(owner, '/sales', saleInput(f.p, f.sessionId), key),
      post(owner, '/sales', saleInput(f.p, f.sessionId), key),
    ]);
    expect(first.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(all(db, 'SELECT * FROM sales')).toHaveLength(1);
    expect(integrity(db).ok).toBe(true);
  });
  it('preserves barcode aliases and unrelated metadata and refuses private evidence as a product image', async () => {
    const f = fixture();
    db = f.db;
    const owner = await auth(createApp(db), f.a);
    let p = (await owner.agent.get('/api/products')).body.products.find((r: any) => r.id === f.p.id);
    const patch = (body: any) =>
      owner.agent
        .patch(`/api/products/${p.id}`)
        .set('X-CSRF-Token', owner.csrf)
        .set('Idempotency-Key', id())
        .send(body);
    expect(
      (
        await patch({
          version: p.version,
          reason: 'Add synthetic scanner test codes',
          barcode: 'TEST-PRIMARY',
          barcodes: ['TEST-PRIMARY', 'TEST-ALIAS'],
          min_stock: 8,
          notes: 'Keep this note',
        })
      ).status,
    ).toBe(200);
    p = (await owner.agent.get('/api/products')).body.products.find((r: any) => r.id === f.p.id);
    expect(
      (
        await patch({
          name: 'Literal <img src=x onerror=alert(1)>',
          version: p.version,
          reason: 'Literal text metadata regression',
        })
      ).status,
    ).toBe(200);
    p = (await owner.agent.get('/api/products')).body.products.find((r: any) => r.id === f.p.id);
    expect(p.barcodes).toEqual(['TEST-PRIMARY', 'TEST-ALIAS']);
    expect(p.min_stock).toBe(8);
    expect(p.size).toBe(f.p.size);
    expect(p.notes).toBe('Keep this note');
    const doc = await post(owner, '/documents', {
      name: 'private.png',
      purpose: 'expense',
      mime: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKxkAAAAASUVORK5CYII=',
    });
    expect(
      (await patch({ version: p.version, reason: 'Wrong document purpose attempt', image: doc.body.url }))
        .status,
    ).toBe(400);
    expect(
      (await patch({ version: p.version, reason: 'Unsafe image URL attempt', image: 'javascript:alert(1)' }))
        .status,
    ).toBe(400);
    expect(integrity(db).ok).toBe(true);
  });
  it('preserves merchant/PIN/register snapshots in all PDF layouts after master data changes', async () => {
    const f = fixture();
    db = f.db;
    db.prepare('UPDATE businesses SET name=?,tax_pin=? WHERE id=?').run(
      'Original synthetic merchant',
      'A000000000Z',
      f.a.business_id,
    );
    db.prepare('UPDATE branches SET name=? WHERE id=?').run('Original test branch', f.a.branch_id);
    const sale = db.transaction(() => createSale(db, f.a, saleInput(f.p, f.sessionId)))();
    db.prepare('UPDATE businesses SET name=?,tax_pin=? WHERE id=?').run(
      'New synthetic merchant',
      'P111111111Z',
      f.a.business_id,
    );
    const owner = await auth(createApp(db), f.a);
    for (const layout of ['80mm', '58mm', 'a4']) {
      const pdf = await owner.agent
        .get(`/api/sales/${sale.id}/receipt?layout=${layout}`)
        .buffer(true)
        .parse(pdfParser);
      expect(pdf.status).toBe(200);
      expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
      const text = pdfText(pdf.body);
      expect(text).toContain('Original synthetic merchant');
      expect(text).toContain('A000000000Z');
      expect(text).toContain('Original test branch');
      expect(text).toContain('Test register');
      expect(text).not.toContain('P111111111Z');
      expect(text).toContain('not an eTIMS');
      expect(pdf.body.toString('latin1')).toMatch(
        layout === '80mm'
          ? /MediaBox \[0 0 226\.77 /
          : layout === '58mm'
            ? /MediaBox \[0 0 164\.41 /
            : /MediaBox \[0 0 595\.28 841\.89\]/,
      );
    }
    expect((await owner.agent.get(`/api/sales/${sale.id}/receipt?layout=unsafe`)).status).toBe(400);
  });
  it('upgrades legacy password hashes, revokes old sessions and rejects malformed hashes safely', async () => {
    const f = fixture();
    db = f.db;
    const salt = randomBytes(16).toString('hex'),
      legacy = `${salt}:${scryptSync('test-password-strong', salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex')}`;
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(legacy, f.a.id);
    const app = createApp(db),
      first = await auth(app, f.a),
      second = await auth(app, f.a);
    expect(one(db, 'SELECT password_hash FROM users WHERE id=?', f.a.id)!.password_hash).toMatch(
      /^scrypt-v2:/,
    );
    expect(one(db, "SELECT id FROM audit_logs WHERE action='auth.password_rehashed'")).toBeTruthy();
    const changed = await first.agent
      .post('/api/auth/password')
      .set('X-CSRF-Token', first.csrf)
      .send({ current: 'test-password-strong', password: 'new-test-private-passphrase' });
    expect(changed.status).toBe(200);
    expect((await second.agent.get('/api/products')).status).toBe(401);
    expect((await first.agent.get('/api/products')).status).toBe(200);
    expect((await first.agent.post('/api/auth/logout').set('X-CSRF-Token', changed.body.csrf)).status).toBe(
      200,
    );
    expect((await first.agent.get('/api/products')).status).toBe(401);
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run('malformed-legacy-data', f.a.id);
    expect(
      (await request(app).post('/api/auth/login').send({ email: f.a.email, password: 'anything' })).status,
    ).toBe(401);
  });
  it('enforces login/password attempt limits and renews the allowance after an expired lockout', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-05T10:00:00Z'));
    const f = fixture();
    db = f.db;
    const app = createApp(db);
    for (let i = 0; i < 5; i++)
      expect(
        (await request(app).post('/api/auth/login').send({ email: f.a.email, password: 'wrong' })).status,
      ).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/auth/login')
          .send({ email: f.a.email, password: 'test-password-strong' })
      ).status,
    ).toBe(429);
    vi.setSystemTime(new Date('2026-09-05T10:16:00Z'));
    expect(
      (await request(app).post('/api/auth/login').send({ email: f.a.email, password: 'wrong' })).status,
    ).toBe(401);
    const owner = await auth(app, f.a);
    for (let i = 0; i < 10; i++)
      expect(
        (
          await owner.agent
            .post('/api/auth/password')
            .set('X-CSRF-Token', owner.csrf)
            .send({ current: 'wrong', password: 'unused-test-passphrase' })
        ).status,
      ).toBe(400);
    expect(
      (
        await owner.agent
          .post('/api/auth/password')
          .set('X-CSRF-Token', owner.csrf)
          .send({ current: 'wrong', password: 'unused-test-passphrase' })
      ).status,
    ).toBe(429);
    vi.setSystemTime(new Date('2026-09-06T02:00:00Z'));
    expect((await owner.agent.get('/api/products')).status).toBe(401);
  });
  it('does not replay or project another branch’s records after administrative reassignment', async () => {
    const f = fixture();
    db = f.db;
    const app = createApp(db),
      owner = await auth(app, f.a),
      key = id(),
      sale = await post(owner, '/sales', saleInput(f.p, f.sessionId), key);
    expect(sale.status).toBe(201);
    const branch = id();
    insert(db, 'branches', { id: branch, business_id: f.a.business_id, name: 'Second synthetic branch' });
    db.prepare('UPDATE users SET branch_id=? WHERE id=?').run(branch, f.a.id);
    expect((await post(owner, '/sales', saleInput(f.p, f.sessionId), key)).status).toBe(403);
    expect((await owner.agent.get('/api/sales/' + sale.body.id)).status).toBe(404);
    expect((await owner.agent.get('/api/workspace/summary')).body.session).toBeNull();
    expect((await owner.agent.get('/api/sessions')).body.current).toBeNull();
    const metric = (await owner.agent.get('/api/analytics/staff')).body.staff.find(
      (s: any) => s.id === f.a.id,
    );
    expect(metric.transactions).toBe(0);
    expect(metric.cash_cents).toBe(0);
    expect((await owner.agent.get('/api/reports/sales')).body.rows).toHaveLength(0);
    expect((await owner.agent.get('/api/operations/' + key)).body.state).toBe('not_found');
    expect(integrity(db).ok).toBe(true);
  });
  it('rejects unknown export filters, never sums unit prices, and keeps AI feature access read-only', async () => {
    const f = fixture();
    db = f.db;
    db.transaction(() => createSale(db, f.a, saleInput(f.p, f.sessionId)))();
    expect(() => getReport(db, f.a, 'sales', { unknown_filter: 'ignored' })).toThrow(/Unsupported/);
    expect(getReport(db, f.a, 'sales', {}).totals).not.toHaveProperty('unit_price_cents');
    for (const dangerous of ['=2+2', '\n=2+2', ' \t@SUM(1)', '\ufeff+HYPERLINK("x")'])
      expect(csvCell(dangerous)).toMatch(/^"'/);
    expect(csvCell('-40.50')).toBe('"-40.50"');
    const app = createApp(db),
      owner = await auth(app, f.a),
      cashier = await auth(app, addUser(db, f.a, 'cashier'));
    expect((await owner.agent.get('/api/intelligence/features')).body.read_only).toBe(true);
    expect((await cashier.agent.get('/api/intelligence/features')).status).toBe(403);
    expect((await post(owner, '/intelligence/features', { stock: 999 })).status).toBe(404);
    expect(integrity(db).ok).toBe(true);
  });
});
