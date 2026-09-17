import { id, now, scope, sha, type Actor } from '../core.js';
import { all, insert, one, type Executor } from './query.js';
import type { Tx } from './transaction.js';

/**
 * The append-only audit chain, ported from `audit()` in server/core.ts.
 *
 * The stored hash covers JSON.stringify of every column except seq and hash, in the column
 * order of the table, and each row records the hash of the row before it. That makes any edit,
 * deletion or reordering detectable by verifyAudit() in server/postgres/check.ts. Two rules
 * follow from it and are enforced here:
 *
 *  1. An audit row may only be written inside a transaction. The chain is global (the previous
 *     hash is the newest row in the whole table, not per business), so writers must be
 *     serialised; `pg_advisory_xact_lock` does that and is released automatically at COMMIT or
 *     ROLLBACK. SQLite got the same guarantee from its single-writer database lock.
 *  2. The key order below must never change, or every previously written hash stops verifying.
 */

/** Arbitrary fixed key: serialises audit writers database-wide for the length of a transaction. */
const AUDIT_CHAIN_LOCK_KEY = 7_423_002;

export async function audit(
  tx: Tx,
  a: Actor,
  action: string,
  entity: string,
  entityId: string,
  before: unknown,
  after: unknown,
  reason: string,
  approvalId: string | null = null,
): Promise<void> {
  if (!('client' in tx) || typeof tx.savepoint !== 'function') {
    throw new Error(
      'audit() requires a transaction; the hash chain cannot be extended safely on a pooled connection',
    );
  }
  await tx.client.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_CHAIN_LOCK_KEY]);
  const previous = await one<{ hash: string }>(tx, 'SELECT hash FROM audit_logs ORDER BY seq DESC LIMIT 1');
  const entry = {
    id: id('aud_'),
    ...scope(a),
    user_id: a.id,
    role: a.role_id,
    action,
    entity,
    entity_id: entityId,
    before_json: JSON.stringify(before ?? null),
    after_json: JSON.stringify(after ?? null),
    reason,
    approval_id: approvalId,
    ip: a.ip ?? '',
    device: (a.device ?? '').slice(0, 300),
    created_at: now(),
    previous_hash: previous?.hash ?? 'GENESIS',
  };
  await insert(tx, 'audit_logs', { ...entry, hash: sha(JSON.stringify(entry)) });
}

/**
 * The actor a request runs as, including effective permissions. Port of db.ts actorFor().
 *
 * Accepts any executor - the pool for a read-only session lookup, or a transaction client when the
 * caller is already inside a financial unit - because it only ever reads.
 */
export async function actorFor(tx: Tx | Executor, userId: string): Promise<Actor | null> {
  const user = await one<Actor & { must_change_password: number }>(
    tx,
    'SELECT id, business_id, branch_id, role_id, name, email, must_change_password FROM users WHERE id = ? AND active = 1',
    userId,
  );
  if (!user) return null;
  const rows = await all<{ permission_id: string }>(
    tx,
    'SELECT permission_id FROM role_permissions WHERE role_id = ?',
    user.role_id,
  );
  const permissions = rows.map((row) => row.permission_id);
  for (const override of await all<{ permission_id: string; allowed: number }>(
    tx,
    'SELECT permission_id, allowed FROM user_permissions WHERE user_id = ?',
    userId,
  )) {
    const index = permissions.indexOf(override.permission_id);
    if (!override.allowed && index >= 0) permissions.splice(index, 1);
    if (override.allowed && index < 0) permissions.push(override.permission_id);
  }
  return { ...user, permissions } as Actor;
}
