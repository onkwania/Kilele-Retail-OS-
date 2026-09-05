import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { fixture, addUser } from './helpers.js';
import { createApp } from '../server/app.js';
import { id, all, one, kenyaDate, integrity, type DB } from '../server/core.js';
let db: DB;
afterEach(() => db?.close());
describe('Existing recovery extended to financial entries', () => {
  it('looks up/replays an expense once and atomically cancels legacy unposted keys without a stored body', async () => {
    const f = fixture();
    db = f.db;
    const app = createApp(db),
      agent = request.agent(app);
    const login = await agent
        .post('/api/auth/login')
        .send({ email: f.a.email, password: 'test-password-strong' }),
      csrf = login.body.csrf;
    const body = {
        category: 'Transport',
        amount: '20',
        expense_date: kenyaDate(),
        method: 'Cash',
        description: 'Synthetic expense recovery',
      },
      key = id();
    const send = () =>
      agent.post('/api/expenses').set('X-CSRF-Token', csrf).set('Idempotency-Key', key).send(body);
    const original = await send();
    expect(original.status).toBe(201);
    expect((await agent.get('/api/operations/' + key)).body.result.id).toBe(original.body.id);
    expect((await send()).body.id).toBe(original.body.id);
    expect(all(db, 'SELECT * FROM expenses')).toHaveLength(1);
    const legacy = id();
    const cancelled = await agent
      .post(`/api/operations/${legacy}/cancel`)
      .set('X-CSRF-Token', csrf)
      .set('Idempotency-Key', id())
      .send({
        method: 'POST',
        path: '/expenses',
        reason: 'Legacy intent cancelled before posting after inspection',
      });
    expect(cancelled.body.state).toBe('cancelled');
    const late = await agent
      .post('/api/expenses')
      .set('X-CSRF-Token', csrf)
      .set('Idempotency-Key', legacy)
      .send(body);
    expect(late.body.code).toBe('SUBMISSION_CANCELLED');
    expect(all(db, 'SELECT * FROM expenses')).toHaveLength(1);
    expect(integrity(db).ok).toBe(true);
  });
  it('does not expose another user’s outcome or allow cancellation of a forbidden operation', async () => {
    const f = fixture();
    db = f.db;
    const cashier = addUser(db, f.a, 'cashier'),
      app = createApp(db),
      owner = request.agent(app),
      cash = request.agent(app);
    const a = await owner
      .post('/api/auth/login')
      .send({ email: f.a.email, password: 'test-password-strong' });
    const b = await cash
      .post('/api/auth/login')
      .send({ email: cashier.email, password: 'test-password-strong' });
    const key = id();
    await owner.post('/api/expenses').set('X-CSRF-Token', a.body.csrf).set('Idempotency-Key', key).send({
      category: 'Transport',
      amount: '10',
      expense_date: kenyaDate(),
      method: 'Cash',
      description: 'Private outcome fixture',
    });
    expect((await cash.get('/api/operations/' + key)).body.state).toBe('not_found');
    expect(
      (
        await cash
          .post(`/api/operations/${id()}/cancel`)
          .set('X-CSRF-Token', b.body.csrf)
          .set('Idempotency-Key', id())
          .send({ method: 'POST', path: '/expenses', reason: 'Attempt forbidden cancellation' })
      ).status,
    ).toBe(403);
    expect(
      (
        await owner
          .post(`/api/operations/${id()}/cancel`)
          .set('X-CSRF-Token', a.body.csrf)
          .set('Idempotency-Key', id())
          .send({ method: 'POST', path: '/auth/password', reason: 'Unsupported operation' })
      ).status,
    ).toBe(400);
    expect(one(db, 'SELECT COUNT(*) n FROM expenses')!.n).toBe(1);
  });
});
