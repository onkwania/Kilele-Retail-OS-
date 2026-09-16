import { randomBytes, scryptSync } from 'node:crypto';

/**
 * Password hashing, extracted from server/db.ts so the PostgreSQL data layer can hash a
 * bootstrap password without importing better-sqlite3. The algorithm, parameters and stored
 * format are unchanged: `scrypt-v2:<hex salt>:<hex digest>`.
 *
 * server/db.ts re-exports these, so every existing import site keeps working.
 */
export const SCRYPT_OPTIONS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt-v2:${salt}:${scryptSync(password, salt, 64, SCRYPT_OPTIONS).toString('hex')}`;
}
