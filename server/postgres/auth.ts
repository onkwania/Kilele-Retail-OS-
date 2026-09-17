import type { Express, Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import { AppError, now, requireThat, sha, type Actor } from '../core.js';
import {
  ATTEMPT_RETENTION_MS,
  AUTH_WINDOW_MS,
  DUMMY_HASH,
  LOCKOUT_FAILURES,
  LOCKOUT_MS,
  LOGIN_ATTEMPT_LIMIT,
  PASSWORD_ATTEMPT_LIMIT,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  expiresAt,
  loginBody,
  passwordChangeBody,
  rejectUnsafeWrite,
  sessionCookieOptions,
  verifyPassword,
} from '../auth-shared.js';
import { getPool } from './db.js';
import { exec, one } from './query.js';
import { transaction } from './transaction.js';
import { actorFor, audit } from './audit.js';
import {
  clearAttempts,
  findActiveSession,
  issueSession,
  isLocked,
  loadAttempt,
  purgeExpiredSessions,
  purgeStaleAttempts,
  recordFailedAttempt,
  rehash,
  revokeSession,
  revokeUserSessions,
} from './sessions.js';

/**
 * Authentication on PostgreSQL - Slice 2 of the migration.
 *
 * This is the async port of `installAuth()` in server/auth.ts, with the same routes, the same
 * messages and the same cookie, so the client cannot tell which engine authenticated it. Three
 * properties are stronger here than they could be on SQLite, and they are the reason the port is
 * written this way:
 *
 *  1. **Bookkeeping for a failed sign-in is committed.** The attempt counter, the lockout and the
 *     `auth.login_failed` audit row are written inside a transaction that then COMMITs, and the
 *     401 is raised afterwards. Throwing inside the transaction instead would roll the counter
 *     back and a brute-force attempt would never reach the lockout threshold.
 *  2. **A successful sign-in, a password change and a sign-out are each one transaction**, so the
 *     audit row describing them cannot outlive or predate the change it describes.
 *  3. **A password change revokes every session for that user**, in the same transaction as the
 *     new hash and the audit row.
 *
 * Session tokens are stored only as SHA-256 hashes, and the CSRF token travels in the response
 * body (never in a cookie) so a cross-site form cannot supply it.
 */

type UserRow = {
  id: string;
  business_id: string;
  branch_id: string;
  role_id: string;
  name: string;
  email: string;
  password_hash: string;
  active: number;
  must_change_password: number;
  created_at: string;
};

type LoginOutcome = { state: 'ok'; token: string; csrf: string; actor: Actor } | { state: 'invalid' };

function deviceOf(req: Request): string {
  return String(req.headers['user-agent'] ?? '');
}

/** The actor plus the request provenance the audit chain records. */
async function auditActor(
  executor: Parameters<typeof actorFor>[0],
  userId: string,
  req: Request,
): Promise<Actor> {
  const actor = await actorFor(executor, userId);
  if (!actor)
    throw new Error(`Cannot load the actor for user ${userId}; refusing to write an unsigned audit row`);
  return { ...actor, ip: req.ip, device: deviceOf(req) };
}

export type PostgresAuthOptions = { preview: boolean; production: boolean; origin?: string };

export function installPostgresAuth(app: Express, options: PostgresAuthOptions): void {
  const cookieOptions = sessionCookieOptions(options);
  const pool = getPool();

  // --- session resolution and the CSRF/origin gate -----------------------------------------
  app.use('/api', async (req: Request, _res: Response, next: (error?: unknown) => void) => {
    try {
      const token = req.cookies?.[SESSION_COOKIE];
      if (typeof token === 'string') {
        const session = await findActiveSession(pool, sha(token));
        if (session) {
          const user = await actorFor(pool, session.user_id);
          if (user) {
            req.actor = { ...user, ip: req.ip, device: deviceOf(req) };
            req.csrf = session.csrf_token;
            req.sessionHash = session.token_hash;
          }
        }
      }
      const rejection = rejectUnsafeWrite(req, options);
      if (rejection) return next(rejection);
      next();
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/auth/me', async (req: Request, res: Response, next: (error?: unknown) => void) => {
    try {
      res.json({
        user: req.actor ?? null,
        csrf: req.csrf ?? null,
        preview: options.preview,
        business: req.actor
          ? await one(pool, 'SELECT * FROM businesses WHERE id = ?', req.actor.business_id)
          : null,
        branch: req.actor
          ? await one(pool, 'SELECT * FROM branches WHERE id = ?', req.actor.branch_id)
          : null,
      });
    } catch (error) {
      next(error);
    }
  });

  const loginLimit = rateLimit({
    windowMs: AUTH_WINDOW_MS,
    limit: LOGIN_ATTEMPT_LIMIT,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' },
  });

  app.post(
    '/api/auth/login',
    loginLimit,
    async (req: Request, res: Response, next: (error?: unknown) => void) => {
      try {
        const body = loginBody.parse(req.body);
        const email = body.email.toLowerCase();
        const outcome = await transaction<LoginOutcome>(async (tx) => {
          const attempt = await loadAttempt(tx, email);
          requireThat(!isLocked(attempt), 'Sign-in is temporarily locked. Try again in 15 minutes.', 429);
          // Emails are lower-cased at every write boundary and made unique by users_email_ci_unique;
          // lower() on both sides is the PostgreSQL form of SQLite's COLLATE NOCASE.
          const user = await one<UserRow>(
            tx,
            'SELECT * FROM users WHERE lower(email) = lower(?) AND active = 1',
            email,
          );
          // verifyPassword runs even when the user is missing, against a dummy hash, so the response
          // time does not reveal which addresses exist.
          if (!user || !verifyPassword(body.password, user.password_hash)) {
            // Counted in SQL so parallel bad logins cannot both store the same number.
            await recordFailedAttempt(tx, email, {
              windowStart: new Date(Date.now() - AUTH_WINDOW_MS).toISOString(),
              at: now(),
              lockThreshold: LOCKOUT_FAILURES,
              lockUntil: expiresAt(LOCKOUT_MS),
            });
            if (user)
              await audit(
                tx,
                await auditActor(tx, user.id, req),
                'auth.login_failed',
                'users',
                user.id,
                null,
                null,
                'Invalid credentials',
              );
            return { state: 'invalid' };
          }
          if (!user.password_hash.startsWith('scrypt-v2:')) {
            await exec(tx, 'UPDATE users SET password_hash = ? WHERE id = ?', rehash(body.password), user.id);
            await audit(
              tx,
              await auditActor(tx, user.id, req),
              'auth.password_rehashed',
              'users',
              user.id,
              null,
              { scheme: 'scrypt-v2' },
              'Upgrade legacy password derivation after successful authentication',
            );
          }
          await clearAttempts(tx, email);
          await purgeExpiredSessions(tx);
          await purgeStaleAttempts(tx, new Date(Date.now() - ATTEMPT_RETENTION_MS).toISOString());
          const token = randomBytes(32).toString('hex');
          const csrf = randomBytes(32).toString('hex');
          await issueSession(tx, {
            userId: user.id,
            token,
            csrf,
            expiresAt: expiresAt(SESSION_TTL_MS),
            ip: req.ip ?? '',
            userAgent: deviceOf(req),
            previousHash: req.sessionHash ?? null,
          });
          await audit(
            tx,
            await auditActor(tx, user.id, req),
            'auth.login',
            'users',
            user.id,
            null,
            null,
            'Password sign-in',
          );
          const actor = await auditActor(tx, user.id, req);
          return { state: 'ok', token, csrf, actor };
        });
        // Raised after COMMIT: the failed-attempt counter and its audit row are already durable.
        if (outcome.state === 'invalid') throw new AppError(401, 'Email or password is incorrect.');
        res.cookie(SESSION_COOKIE, outcome.token, cookieOptions);
        res.json({ csrf: outcome.csrf, user: outcome.actor });
      } catch (error) {
        next(error);
      }
    },
  );

  if (options.preview)
    app.post(
      '/api/auth/preview',
      loginLimit,
      async (req: Request, res: Response, next: (error?: unknown) => void) => {
        try {
          const outcome = await transaction(async (tx) => {
            const owner = await one<{ id: string }>(
              tx,
              "SELECT id FROM users WHERE role_id = 'super_admin' ORDER BY created_at LIMIT 1",
            );
            requireThat(owner, 'Preview workspace is not initialised.', 503);
            const token = randomBytes(32).toString('hex');
            const csrf = randomBytes(32).toString('hex');
            await issueSession(tx, {
              userId: owner!.id,
              token,
              csrf,
              expiresAt: expiresAt(SESSION_TTL_MS),
              ip: req.ip ?? '',
              userAgent: deviceOf(req),
              previousHash: req.sessionHash ?? null,
            });
            await audit(
              tx,
              await auditActor(tx, owner!.id, req),
              'auth.preview_login',
              'users',
              owner!.id,
              null,
              null,
              'Isolated development preview; never for production',
            );
            return { token, csrf, actor: await auditActor(tx, owner!.id, req) };
          });
          res.cookie(SESSION_COOKIE, outcome.token, cookieOptions);
          res.json({ csrf: outcome.csrf, user: outcome.actor });
        } catch (error) {
          next(error);
        }
      },
    );

  app.post('/api/auth/logout', async (req: Request, res: Response, next: (error?: unknown) => void) => {
    try {
      if (req.actor) {
        await transaction(async (tx) => {
          await revokeSession(tx, req.sessionHash);
          await audit(tx, req.actor, 'auth.logout', 'users', req.actor.id, null, null, 'User signed out');
        });
      }
      res.clearCookie(SESSION_COOKIE, { ...cookieOptions, maxAge: undefined }).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  const passwordLimit = rateLimit({
    windowMs: AUTH_WINDOW_MS,
    limit: PASSWORD_ATTEMPT_LIMIT,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many password-change attempts. Try again later.' },
  });

  app.post(
    '/api/auth/password',
    passwordLimit,
    async (req: Request, res: Response, next: (error?: unknown) => void) => {
      try {
        requireThat(req.actor, 'Sign in first.', 401);
        const body = passwordChangeBody.parse(req.body);
        const outcome = await transaction(async (tx) => {
          const user = await one<UserRow>(tx, 'SELECT * FROM users WHERE id = ?', req.actor.id);
          requireThat(user, 'Sign in first.', 401);
          requireThat(
            verifyPassword(body.current, user!.password_hash),
            'Current password is incorrect.',
            400,
          );
          requireThat(body.current !== body.password, 'Choose a different password.');
          await exec(
            tx,
            'UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?',
            rehash(body.password),
            user!.id,
          );
          // Every session dies with the old password, including this one; a fresh session is issued
          // below so the person who changed it is not signed out of their own device.
          await revokeUserSessions(tx, user!.id);
          await audit(
            tx,
            req.actor,
            'auth.password_changed',
            'users',
            user!.id,
            null,
            { sessions_revoked: true },
            'User password change',
          );
          const token = randomBytes(32).toString('hex');
          const csrf = randomBytes(32).toString('hex');
          await issueSession(tx, {
            userId: user!.id,
            token,
            csrf,
            expiresAt: expiresAt(SESSION_TTL_MS),
            ip: req.ip ?? '',
            userAgent: deviceOf(req),
            previousHash: null,
          });
          return { token, csrf, actor: await auditActor(tx, user!.id, req) };
        });
        res.cookie(SESSION_COOKIE, outcome.token, cookieOptions);
        res.json({ csrf: outcome.csrf, user: outcome.actor });
      } catch (error) {
        next(error);
      }
    },
  );
}

/** Exposed for the startup banner and tests: is any user signed in right now? */
export async function countActiveSessions(): Promise<number> {
  const row = await one<{ live: number }>(
    getPool(),
    'SELECT COUNT(*)::int AS live FROM auth_sessions WHERE expires_at > ?',
    now(),
  );
  return row?.live ?? 0;
}

export { DUMMY_HASH, verifyPassword, sessionCookieOptions };
