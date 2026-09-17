import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { inflateSync } from 'node:zlib';
import { fixture, addUser, saleInput } from './helpers.js';
import { createApp } from '../server/app.js';
import { one, all, insert, id, now, integrity, type DB, type Actor } from '../server/core.js';

/**
 * Customer master data (`GET/POST /api/customers`), `sales.customer_id` and its composite foreign key
 * already existed, but no client surface, no read projection and no test reached them. These cases
 * pin the now-exposed behaviour: business-scoped records, an honest projection back into sales and
 * receipts, and no silent credit/balance semantics.
 */
let db: DB;
afterEach(() => {
  db?.close();
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
const otherBusinessCustomer = (a: Actor) => {
  const businessId = id('biz_'),
    customerId = id('cus_');
  insert(db, 'businesses', { id: businessId, name: 'Another tenant', created_at: now() });
  insert(db, 'customers', {
    id: customerId,
    business_id: businessId,
    name: 'Customer of another business',
    phone: '',
    email: '',
    created_at: now(),
  });
  expect(a.business_id).not.toBe(businessId);
  return customerId;
};

describe('Customer master data and per-sale attachment', () => {
  it('creates a customer over HTTP, attaches it to a real sale and projects the name back', async () => {
    const f = fixture();
    db = f.db;
    const app = createApp(db),
      owner = await auth(app, f.a);

    const created = await post(owner, '/customers', {
      name: 'Synthetic regular buyer',
      phone: '+254700000000',
      email: 'buyer@test.co.ke',
    });
    expect(created.status).toBe(201);
    expect(created.body.ok).toBe(true);
    expect(created.body.customer.id).toMatch(/^cus_/);

    // fixture() already opened the owner's one live register; a second open session is refused.
    const session = f.sessionId;
    const sale = await post(owner, '/sales', {
      ...saleInput(f.p, session),
      customer_id: created.body.customer.id,
    });
    expect(sale.status).toBe(201);

    const stored = one(db, 'SELECT customer_id,receipt_snapshot_json FROM sales WHERE id=?', sale.body.id)!;
    expect(stored.customer_id).toBe(created.body.customer.id);
    // The buyer is snapshotted with the merchant identity, like the branch and register.
    expect(JSON.parse(stored.receipt_snapshot_json).customer.name).toBe('Synthetic regular buyer');

    const list = await owner.agent.get('/api/sales');
    expect(list.body.sales[0].customer_name).toBe('Synthetic regular buyer');

    const detail = await owner.agent.get(`/api/sales/${sale.body.id}`);
    expect(detail.body.sale.customer_name).toBe('Synthetic regular buyer');

    const receipt = await owner.agent.get(`/api/sales/${sale.body.id}/receipt?layout=80mm`).parse(pdfParser);
    expect(pdfText(receipt.body)).toContain('Sold to: Synthetic regular buyer');

    expect(
      all(
        db,
        "SELECT id FROM audit_logs WHERE action='customer.created' AND entity_id=?",
        created.body.customer.id,
      ).length,
    ).toBe(1);
    expect(integrity(db).ok).toBe(true);
  });

  it('keeps a walk-in sale free of any customer reference in the record and on the receipt', async () => {
    const f = fixture();
    db = f.db;
    const app = createApp(db),
      owner = await auth(app, f.a);
    const session = f.sessionId;
    const sale = await post(owner, '/sales', saleInput(f.p, session));
    expect(sale.status).toBe(201);

    const stored = one(db, 'SELECT customer_id,receipt_snapshot_json FROM sales WHERE id=?', sale.body.id)!;
    expect(stored.customer_id).toBeNull();
    expect(JSON.parse(stored.receipt_snapshot_json).customer).toBeNull();

    const detail = await owner.agent.get(`/api/sales/${sale.body.id}`);
    expect(detail.body.sale.customer_name).toBeNull();

    const receipt = await owner.agent.get(`/api/sales/${sale.body.id}/receipt?layout=a4`).parse(pdfParser);
    expect(pdfText(receipt.body)).not.toContain('Sold to:');
    expect(integrity(db).ok).toBe(true);
  });

  it('refuses another business’s customer and never lists it', async () => {
    const f = fixture();
    db = f.db;
    const app = createApp(db),
      owner = await auth(app, f.a),
      foreign = otherBusinessCustomer(f.a);

    const session = f.sessionId;
    const sale = await post(owner, '/sales', { ...saleInput(f.p, session), customer_id: foreign });
    expect(sale.status).toBe(404);
    expect(one(db, 'SELECT COUNT(*) n FROM sales')!.n).toBe(0);

    const mine = await post(owner, '/customers', { name: 'Own customer only', phone: '', email: '' });
    const listed = await owner.agent.get('/api/customers');
    expect(listed.body.customers.map((c: { id: string }) => c.id)).toEqual([mine.body.customer.id]);
    expect(listed.body.customers.some((c: { id: string }) => c.id === foreign)).toBe(false);
  });

  it('lets a cashier attach a customer but denies the list to a role without selling rights', async () => {
    const f = fixture();
    db = f.db;
    const cashier = addUser(db, f.a, 'cashier', 'Restricted cashier'),
      inventoryStaff = addUser(db, f.a, 'inventory', 'Stock keeper'),
      app = createApp(db),
      till = await auth(app, cashier),
      stock = await auth(app, inventoryStaff);

    expect((await stock.agent.get('/api/customers')).status).toBe(403);
    expect((await post(stock, '/customers', { name: 'Not permitted here' })).status).toBe(403);

    const customer = (await post(till, '/customers', { name: 'Till customer', phone: '', email: '' })).body
      .customer;
    const session = (await post(till, '/sessions', { register: 'Till one', opening: '200' })).body.session.id;
    const sale = await post(till, '/sales', { ...saleInput(f.p, session), customer_id: customer.id });
    expect(sale.status).toBe(201);
    // A cashier still cannot see recorded buying costs through the sale projection.
    const detail = await till.agent.get(`/api/sales/${sale.body.id}`);
    expect(detail.body.sale.customer_name).toBe('Till customer');
    expect(detail.body.sale.cogs_cents).toBeUndefined();
  });

  it('replays one customer creation per durable key and rejects invented or malformed records', async () => {
    const f = fixture();
    db = f.db;
    const app = createApp(db),
      owner = await auth(app, f.a),
      key = id();

    const first = await post(owner, '/customers', { name: 'Durable customer', phone: '', email: '' }, key);
    expect(first.status).toBe(201);
    const replay = await post(owner, '/customers', { name: 'Durable customer', phone: '', email: '' }, key);
    expect(replay.status).toBe(201);
    expect(replay.body.customer.id).toBe(first.body.customer.id);
    expect(one(db, 'SELECT COUNT(*) n FROM customers')!.n).toBe(1);

    // A changed body may not reuse a committed key.
    expect(
      (await post(owner, '/customers', { name: 'Different person', phone: '', email: '' }, key)).status,
    ).toBe(409);
    expect((await post(owner, '/customers', { name: 'A' })).status).toBe(400);
    expect((await post(owner, '/customers', { name: 'Bad email', email: 'not-an-email' })).status).toBe(400);
    expect((await post(owner, '/customers', { name: 'Extra field', credit_limit: '5000' })).status).toBe(400);
    const noCsrf = await owner.agent
      .post('/api/customers')
      .set('Idempotency-Key', id())
      .send({ name: 'No CSRF token' });
    expect(noCsrf.status).toBe(403);
    // No credit semantics exist: an attached customer never creates a balance or a payable.
    expect(all(db, "SELECT name FROM sqlite_master WHERE name LIKE '%customer_balance%'")).toEqual([]);
    expect(integrity(db).ok).toBe(true);
  });
});
