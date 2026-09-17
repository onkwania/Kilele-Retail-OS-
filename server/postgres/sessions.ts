import { now, sha } from '../core.js';
import { hashPassword } from '../passwords.js';
import { exec, insert, one, type Executor } from './query.js';
import type { Tx } from './transaction.js';

/**
 * Authentication state on PostgreSQL: sessions, CSRF tokens and the sign-in attempt ledger.
 *
 * Ported from the SQLite statements in server/auth.ts with three rules that the ledger depends on:
 *
 *  1. **Only the hash of a session token is stored.** The bearer token is generated per session,
 *     returned in an httpOnly cookie, and never written to the database, a log or an audit row.
 *     A stolen database therefore does not hand over live sessions.
 *  2. **Every write happens inside the caller's transaction.** Revoking sessions and writing the
 *     audit row that describes the revocation must succeed or fail together, otherwise a password
 *     change could leave an old session alive with no record of why.
 *  3. **A password or access change revokes every session for that user**, not just the current
 *     one, so a stolen cookie dies with the password it was issued under.
 */

export type SessionRow = {
  token_hash: string;
  user_id: string;
  csrf_token: string;
  expires_at: string;
  created_at: string;
  ip: string;
  user_agent: string;
};

export type LoginAttempt = {
  email: string;
  failures: number;
  locked_until: string | null;
  updated_at: string;
};

/** A freshly minted session: the raw token goes to the cookie, the hash stays here. */
export type IssuedSession = { token: string; tokenHash: string; csrf: string; expiresAt: string };

/** Finds a live session by the SHA-256 hash of the presented cookie value. */
export async function findActiveSession(
  executor: Executor,
  tokenHash: string,
  at = now(),
): Promise<SessionRow | null> {
  return one<SessionRow>(
    executor,
    'SELECT token_hash, user_id, csrf_token, expires_at, created_at, ip, user_agent FROM auth_sessions WHERE token_hash = ? AND expires_at > ?',
    tokenHash,
    at,
  );
}

/** Removes sessions that have passed their expiry, so the table cannot grow without bound. */
export async function purgeExpiredSessions(tx: Tx, at = now()): Promise<number> {
  return exec(tx, 'DELETE FROM auth_sessions WHERE expires_at <= ?', at);
}

/** Prunes sign-in attempt history older than the retention window. */
export async function purgeStaleAttempts(tx: Tx, cutoff: string): Promise<number> {
  return exec(tx, 'DELETE FROM login_attempts WHERE updated_at < ?', cutoff);
}

/**
 * Writes one new session row and returns the token to hand to the browser.
 *
 * `previousHash` is the session this request arrived on: replacing it in the same transaction
 * means a re-authentication can never leave two live sessions for one sign-in.
 */
export async function issueSession(
  tx: Tx,
  params: {
    userId: string;
    token: string;
    csrf: string;
    expiresAt: string;
    ip: string;
    userAgent: string;
    previousHash?: string | null;
  },
): Promise<IssuedSession> {
  if (params.previousHash) {
    await exec(tx, 'DELETE FROM auth_sessions WHERE token_hash = ?', params.previousHash);
  }
  const tokenHash = sha(params.token);
  await insert(tx, 'auth_sessions', {
    token_hash: tokenHash,
    user_id: params.userId,
    csrf_token: params.csrf,
    expires_at: params.expiresAt,
    created_at: now(),
    ip: params.ip ?? '',
    user_agent: (params.userAgent ?? '').slice(0, 300),
  });
  return { token: params.token, tokenHash, csrf: params.csrf, expiresAt: params.expiresAt };
}

/** Revokes a single session (sign-out). */
export async function revokeSession(tx: Tx, tokenHash: string): Promise<number> {
  return exec(tx, 'DELETE FROM auth_sessions WHERE token_hash = ?', tokenHash);
}

/** Revokes every session belonging to a user (password change, deactivation, access change). */
export async function revokeUserSessions(tx: Tx, userId: string): Promise<number> {
  return exec(tx, 'DELETE FROM auth_sessions WHERE user_id = ?', userId);
}

export async function loadAttempt(executor: Executor, email: string): Promise<LoginAttempt | null> {
  return one<LoginAttempt>(
    executor,
    'SELECT email, failures, locked_until, updated_at FROM login_attempts WHERE email = ?',
    email,
  );
}

/**
 * Records a failed sign-in and returns the new failure count.
 *
 * The increment happens in SQL, not in JavaScript. A read-modify-write here would let two
 * simultaneous bad logins both compute `failures = 1` and store 1, so an attacker sending
 * parallel requests would never reach the lockout threshold. `ON CONFLICT DO UPDATE` makes the
 * second writer block on the unique index and then add to the committed value.
 *
 * The counter also resets itself: a failure that arrives after the attempt window has passed, or
 * after a lockout has already expired, starts a new count rather than extending an old one. That
 * matches the SQLite behaviour in server/auth.ts.
 */
export async function recordFailedAttempt(
  tx: Tx,
  email: string,
  options: { windowStart: string; at: string; lockThreshold: number; lockUntil: string },
): Promise<number> {
  const { windowStart, at, lockThreshold, lockUntil } = options;
  // `new_failures` is written twice because PostgreSQL evaluates every SET expression against the
  // pre-update row; repeating it keeps the lock decision consistent with the stored count.
  const newFailures = `(CASE WHEN la.updated_at < ? OR (la.locked_until IS NOT NULL AND la.locked_until <= ?) THEN 1 ELSE la.failures + 1 END)`;
  const row = await one<{ failures: number }>(
    tx,
    `INSERT INTO login_attempts AS la (email, failures, locked_until, updated_at)
     VALUES (?, 1, NULL, ?)
     ON CONFLICT (email) DO UPDATE SET
       failures = ${newFailures},
       locked_until = (CASE WHEN ${newFailures} >= ? THEN ?::text ELSE NULL END),
       updated_at = excluded.updated_at
     RETURNING failures`,
    email,
    at,
    // conflict branch: windowStart, at, then windowStart, at, threshold, lockUntil
    windowStart,
    at,
    windowStart,
    at,
    lockThreshold,
    lockUntil,
  );
  return row?.failures ?? 1;
}

/** A successful sign-in clears the counter for that address. */
export async function clearAttempts(tx: Tx, email: string): Promise<number> {
  return exec(tx, 'DELETE FROM login_attempts WHERE email = ?', email);
}

/** True when the address is inside its lockout window. */
export function isLocked(attempt: LoginAttempt | null, at = now()): boolean {
  return !!attempt?.locked_until && attempt.locked_until > at;
}

/**
 * Re-hashes a password with the current scrypt parameters and returns the stored form.
 * Kept next to the session helpers because the only caller is a successful sign-in that found a
 * legacy hash: the upgrade is written in the same transaction as the audit row describing it.
 */
export function rehash(password: string): string {
  return hashPassword(password);
}
