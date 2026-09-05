import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { fixture, addUser, saleInput } from './helpers.js';
import { one, all, insert, id, now, integrity, scope, type DB } from '../server/core.js';
import { createSale } from '../server/sales.js';
import { createApp } from '../server/app.js';
import { saveUser } from '../server/management.js';
import { actorFor, hashPassword } from '../server/db.js';
let db: DB;
afterEach(() => db?.close());
const replace = (table: string, row: Record<string, unknown>) => {
  const keys = Object.keys(row);
  db.prepare(`INSERT OR REPLACE INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?')})`).run(
    ...keys.map((k) => row[k]),
  );
};
describe('Second-pass P0 regressions', () => {
  it('rejects REPLACE of immutable sale, journal and audit rows or a populated inventory balance', () => {
    const f = fixture();
    db = f.db;
    const sale = db.transaction(() => createSale(db, f.a, saleInput(f.p, f.sessionId)))();
    const original = one(db, 'SELECT * FROM sales WHERE id=?', sale.id)!;
    expect(() =>
      replace('sales', {
        ...original,
        total_cents: original.total_cents + 1,
        subtotal_cents: original.subtotal_cents + 1,
      }),
    ).toThrow(/immutable/);
    for (const table of ['audit_logs', 'journal_entries', 'journal_lines'])
      expect(() => replace(table, one(db, `SELECT * FROM ${table} LIMIT 1`)!)).toThrow(/immutable/);
    expect(() =>
      replace('inventory', { ...scope(f.a), product_id: f.p.id, quantity: 0, value_cents: 0, version: 0 }),
    ).toThrow(/cannot be deleted/);
    expect(integrity(db).ok).toBe(true);
  });
  it('detects financially inconsistent snapshots even if a host administrator bypasses guards', () => {
    const f = fixture();
    db = f.db;
    const sale = db.transaction(() => createSale(db, f.a, saleInput(f.p, f.sessionId)))();
    db.pragma('recursive_triggers=OFF');
    const original = one(db, 'SELECT * FROM sales WHERE id=?', sale.id)!;
    replace('sales', {
      ...original,
      total_cents: original.total_cents + 1,
      subtotal_cents: original.subtotal_cents + 1,
    });
    const report = integrity(db);
    expect(report.ok).toBe(false);
    expect(report.errors).toContain('Sale header does not match recorded sale items');
    expect(report.errors).toContain('Sale tenders do not reconcile to sale and returns');
  });
  it('preserves an accountant report-deny override through an unrelated metadata edit', () => {
    const f = fixture();
    db = f.db;
    const staff = addUser(db, f.a, 'accountant');
    const input = {
      name: staff.name,
      email: staff.email,
      role_id: staff.role_id,
      active: true,
      reason: 'Metadata-only edit audit test',
    };
    saveUser(db, f.a, { ...input, reports_access: false }, staff.id);
    saveUser(db, f.a, input, staff.id);
    expect(actorFor(db, staff.id)!.permissions).not.toContain('reports.read');
    const audit = one(db, "SELECT * FROM audit_logs WHERE action='staff.updated' ORDER BY seq DESC LIMIT 1")!;
    expect(JSON.parse(audit.before_json).permission_overrides).toContainEqual({
      permission_id: 'reports.read',
      allowed: 0,
    });
    expect(JSON.parse(audit.after_json).effective_permissions).not.toContain('reports.read');
  });
  it('does not disclose another tenant’s audit counts or financial failures through the integrity API', async () => {
    const f = fixture();
    db = f.db;
    const business = id(),
      branch = id(),
      user = id();
    insert(db, 'businesses', { id: business, name: 'Synthetic isolated tenant', created_at: now() });
    insert(db, 'branches', { id: branch, business_id: business, name: 'Other branch' });
    insert(db, 'users', {
      id: user,
      business_id: business,
      branch_id: branch,
      role_id: 'admin',
      name: 'Other admin',
      email: 'second-pass-other@test.co.ke',
      password_hash: hashPassword('test-password-strong'),
      created_at: now(),
    });
    const agent = request.agent(createApp(db));
    await agent
      .post('/api/auth/login')
      .send({ email: 'second-pass-other@test.co.ke', password: 'test-password-strong' });
    const result = await agent.get('/api/integrity');
    expect(result.status).toBe(200);
    expect(result.body.auditEvents).toBe(1);
    expect(result.body.scope).toBe('business_branch');
    expect(result.body.ok).toBe(true);
    expect(all(db, 'SELECT * FROM audit_logs').length).toBeGreaterThan(result.body.auditEvents);
  });
});

describe('Provenance cannot be changed through editable user metadata', () => {
  it('does not enable preview on unmarked operational data just because a user has a preview-like email', () => {
    const f = fixture();
    db = f.db;
    const user = addUser(db, f.a, 'cashier');
    db.prepare('UPDATE users SET email=? WHERE id=?').run('not-a-preview@preview.kilele.local', user.id);
    expect(() => createApp(db, { preview: true })).toThrow(/Refusing preview/);
    expect(one(db, "SELECT kind FROM environment_markers WHERE kind='preview'")).toBeUndefined();
  });
  it('keeps an explicitly operational database operational when staff metadata contains a reserved-looking email', () => {
    const f = fixture();
    db = f.db;
    createApp(db, { production: true, origin: 'https://shop.example.test' });
    const user = addUser(db, f.a, 'cashier');
    db.prepare('UPDATE users SET email=? WHERE id=?').run('not-a-preview@preview.kilele.local', user.id);
    expect(() => createApp(db, { production: true, origin: 'https://shop.example.test' })).not.toThrow();
    expect(() => createApp(db, { preview: true })).toThrow(/operational/);
  });
});
