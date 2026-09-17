import type { CookieOptions } from 'express';
import { scryptSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError, demand, type Actor } from './core.js';
import { hashPassword, SCRYPT_OPTIONS } from './passwords.js';

/**
 * Engine-neutral authentication primitives.
 *
 * Password verification, the session cookie policy, the CSRF/origin gate, the lockout thresholds
 * and the `protect()` middleware are security decisions, not storage decisions: a client must get
 * exactly the same behaviour whether the ledger sits in SQLite or PostgreSQL. They are defined
 * once here so neither HTTP surface can drift from the other.
 *
 * This module deliberately imports no database driver - `server/core.ts` imports better-sqlite3
 * for types only, and `server/passwords.ts` is pure node:crypto - so the PostgreSQL path can use
 * it without ever loading the SQLite engine.
 */

export const SESSION_COOKIE = 'kilele_session';
/** Sessions live for 12 hours; the cookie and the stored row must agree. */
export const SESSION_TTL_MS = 12 * 3600_000;
/** Login and password endpoints are limited over the same window the lockout uses. */
export const AUTH_WINDOW_MS = 15 * 60_000;
export const LOGIN_ATTEMPT_LIMIT = 20;
export const PASSWORD_ATTEMPT_LIMIT = 10;
/** Failed sign-ins before the address is locked out, and for how long. */
export const LOCKOUT_FAILURES = 5;
export const LOCKOUT_MS = 15 * 60_000;
/** Login attempt history older than this is pruned whenever a session is issued. */
export const ATTEMPT_RETENTION_MS = 30 * 86_400_000;

/** Cookie policy for an authenticated session. Isolated embedded previews need a secure
 * partitioned cookie; production remains first-party SameSite=Strict. */
export type SessionCookie = CookieOptions;

export function sessionCookieOptions(options: { preview: boolean; production: boolean }): SessionCookie {
  return {
    httpOnly: true,
    secure: options.production || options.preview,
    sameSite: options.preview ? ('none' as const) : ('strict' as const),
    partitioned: options.preview,
    path: '/',
    maxAge: SESSION_TTL_MS,
  };
}

/**
 * A constant-cost hash for the "user does not exist" path. Without it a missing account returns
 * in microseconds while a real one pays the scrypt cost, which turns response time into an
 * account-enumeration oracle.
 */
export const DUMMY_HASH = hashPassword('dummy-password-not-used');

/**
 * Verifies a password against a stored hash, accepting the legacy `salt:key` derivation as well as
 * the current `scrypt-v2:` one so an existing user can still sign in and be upgraded in place.
 * The comparison is timing-safe and a malformed hash is treated as a failure, never as a crash.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const modern = typeof stored === 'string' && /^scrypt-v2:[a-f0-9]{32}:[a-f0-9]{128}$/.test(stored);
  const legacy = typeof stored === 'string' && /^[a-f0-9]{32}:[a-f0-9]{128}$/.test(stored);
  const parts = (modern || legacy ? stored : DUMMY_HASH).split(':');
  const salt = parts[parts.length - 2];
  const key = parts[parts.length - 1];
  const computed = scryptSync(password, salt, 64, legacy ? { N: 16384, r: 8, p: 1 } : SCRYPT_OPTIONS);
  return (modern || legacy) && timingSafeEqual(Buffer.from(key, 'hex'), computed);
}

/** Gate every authenticated route: signed in, not on a temporary password, and permitted. */
export function protect(permission?: string) {
  return (req: { actor?: Actor }, _res: unknown, next: (error?: unknown) => void) => {
    if (!req.actor) return next(new AppError(401, 'Please sign in to continue.', 'UNAUTHENTICATED'));
    if (req.actor.must_change_password)
      return next(
        new AppError(403, 'Change your temporary password before continuing.', 'PASSWORD_CHANGE_REQUIRED'),
      );
    if (permission) demand(req.actor, permission);
    next();
  };
}

export type OriginOptions = { production: boolean; origin?: string };

/**
 * The CSRF and cross-site gate, shared by both engines.
 *
 * Returns the rejection to send, or null when the request may proceed. Rules, in order:
 *  1. an `Origin` header must match the configured APP_ORIGIN. Outside production, localhost and
 *     the sandbox preview host are also accepted, because that is where the browser suite runs.
 *     A malformed Origin fails closed.
 *  2. `Sec-Fetch-Site: cross-site` is refused outright - a browser only sends it for a genuine
 *     cross-site request.
 *  3. an authenticated state-changing request must carry the session's CSRF token, except the two
 *     endpoints that establish a session in the first place.
 */
export function rejectUnsafeWrite(
  req: {
    method: string;
    path: string;
    headers: Record<string, string | string[] | undefined>;
    actor?: Actor;
    csrf?: string;
  },
  options: OriginOptions,
): AppError | null {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return null;
  const rawOrigin = req.headers.origin;
  const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  if (origin) {
    let allowed = origin === options.origin;
    if (!options.production) {
      try {
        const url = new URL(origin);
        allowed ||=
          url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname.endsWith('.e2b.app');
      } catch {
        /* fail closed */
      }
    }
    if (!allowed) return new AppError(403, 'Request origin is not allowed.', 'CSRF_REJECTED');
  }
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site') return new AppError(403, 'Cross-site request blocked.');
  if (
    req.actor &&
    req.path !== '/auth/login' &&
    req.path !== '/auth/preview' &&
    req.headers['x-csrf-token'] !== req.csrf
  )
    return new AppError(403, 'Security token is missing or expired. Refresh and try again.', 'CSRF_REJECTED');
  return null;
}

export const loginBody = z
  .object({ email: z.string().email().max(200), password: z.string().min(1).max(200) })
  .strict();

export const passwordChangeBody = z
  .object({ current: z.string().max(200), password: z.string().min(12).max(200) })
  .strict();

/** ISO timestamp `ms` from now. Session expiry and lockout both use absolute ISO strings. */
export function expiresAt(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/** True when the account may sign in: present, active, and not merely deactivated. */
export function isActive(user: { active: number | boolean } | null | undefined): boolean {
  return !!user && Number(user.active) === 1;
}
