import { describe, it, expect, afterEach } from 'vitest';
import { fixture, addUser } from './helpers.js';
import { saveUser } from '../server/management.js';
import { actorFor } from '../server/db.js';
import { all, integrity, type DB } from '../server/core.js';
let db: DB;
afterEach(() => db?.close());
describe('Staff privilege boundaries', () => {
  it('provisions staff with temporary passwords but prevents administrator escalation', () => {
    const f = fixture();
    db = f.db;
    const admin = addUser(db, f.a, 'admin');
    expect(() =>
      saveUser(db, admin, {
        name: 'Bad admin',
        email: 'bad@test.co.ke',
        role_id: 'super_admin',
        password: 'test-password-strong',
        reason: 'Attempt privilege escalation',
      }),
    ).toThrow(/super administrator/);
    const user = saveUser(db, f.a, {
      name: 'New staff',
      email: 'new@test.co.ke',
      role_id: 'accountant',
      password: 'test-password-strong',
      reports_access: false,
      reason: 'New staff member created',
    });
    expect(actorFor(db, user.id)?.must_change_password).toBe(1);
    expect(actorFor(db, user.id)?.permissions).not.toContain('reports.read');
    expect(integrity(db).ok).toBe(true);
    expect(all(db, "SELECT * FROM audit_logs WHERE after_json LIKE '%test-password-strong%'")).toHaveLength(
      0,
    );
  });
  it('does not allow self-demotion or self-deactivation', () => {
    const f = fixture();
    db = f.db;
    expect(() =>
      saveUser(
        db,
        f.a,
        {
          name: f.a.name,
          email: f.a.email,
          role_id: 'cashier',
          active: true,
          reason: 'Attempt self demotion',
        },
        f.a.id,
      ),
    ).toThrow(/your own role/);
  });
});
