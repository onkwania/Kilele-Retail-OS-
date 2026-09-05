import { it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDb } from '../server/db.js';
import { insert, one, all, now } from '../server/core.js';
it('rolls back schema reconstruction and guard changes if a later migration constraint fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kilele-migration-failure-')),
    file = join(dir, 'legacy.sqlite');
  try {
    const old = new Database(file);
    old.exec(readFileSync('tests/fixtures/schema-v1.sql', 'utf8'));
    insert(old, 'businesses', { id: 'business', name: 'Synthetic migration business', created_at: now() });
    insert(old, 'branches', { id: 'branch', business_id: 'business', name: 'Synthetic branch' });
    insert(old, 'roles', { id: 'cashier', name: 'Cashier' });
    for (let i = 0; i < 2; i++) {
      insert(old, 'users', {
        id: 'u' + i,
        business_id: 'business',
        branch_id: 'branch',
        role_id: 'cashier',
        name: 'Test ' + i,
        email: `fixture${i}@example.test`,
        password_hash: 'unused fixture hash',
        created_at: now(),
      });
      insert(old, 'cash_sessions', {
        id: 's' + i,
        business_id: 'business',
        branch_id: 'branch',
        user_id: 'u' + i,
        register: i ? 'REGISTER ONE' : 'Register One',
        opening_cents: 0,
        opened_at: now(),
      });
    }
    old.exec(
      "CREATE TRIGGER fixture_canary BEFORE UPDATE ON sales BEGIN SELECT RAISE(ABORT,'legacy guard'); END;",
    );
    old.close();
    expect(() => createDb(file)).toThrow();
    const checked = new Database(file, { readonly: true });
    expect(all(checked, 'PRAGMA table_info(purchases)').some((c) => c.name === 'replaces_id')).toBe(false);
    expect(
      one(checked, "SELECT name FROM sqlite_master WHERE type='trigger' AND name='fixture_canary'"),
    ).toBeTruthy();
    expect(one(checked, 'SELECT COUNT(*) n FROM cash_sessions')!.n).toBe(2);
    checked.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
