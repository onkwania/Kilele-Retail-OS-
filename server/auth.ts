import type { Request, Response, Express } from 'express';
import { randomBytes } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import { type Actor, type DB, AppError, audit, now, one, sha, requireThat } from './core.js';
import { actorFor, hashPassword } from './db.js';
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
  protect,
  rejectUnsafeWrite,
  sessionCookieOptions,
  verifyPassword,
  type SessionCookie,
} from './auth-shared.js';

declare module 'express-serve-static-core' {
  interface Request {
    actor: Actor;
    csrf: string;
    sessionHash: string;
  }
}

/**
 * Authentication on the SQLite ledger.
 *
 * Everything that is a security decision rather than a storage decision - password verification,
 * the cookie policy, the CSRF/origin gate, the lockout thresholds and `protect()` - lives in
 * server/auth-shared.ts and is re-exported here, so every existing call site keeps importing from
 * server/auth.js while the PostgreSQL surface (server/postgres/auth.ts) uses the same code.
 */
export { protect, verifyPassword, sessionCookieOptions, DUMMY_HASH };
export type { SessionCookie };

/** Issue one 12-hour session for an already-authenticated user. Shared by password sign-in, password
 * change and invitation acceptance so every entry point enforces identical session hygiene. */
export function issueSession(
  db: DB,
  req: Request,
  res: Response,
  userId: string,
  cookieOptions: SessionCookie,
) {
  db.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').run(now());
  db.prepare('DELETE FROM login_attempts WHERE updated_at<?').run(
    new Date(Date.now() - ATTEMPT_RETENTION_MS).toISOString(),
  );
  if (req.sessionHash) db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(req.sessionHash);
  const token = randomBytes(32).toString('hex'),
    csrf = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO auth_sessions VALUES(?,?,?,?,?,?,?)').run(
    sha(token),
    userId,
    csrf,
    expiresAt(SESSION_TTL_MS),
    now(),
    req.ip ?? '',
    String(req.headers['user-agent'] ?? '').slice(0, 300),
  );
  res.cookie(SESSION_COOKIE, token, cookieOptions);
  return csrf;
}

export function installAuth(
  app: Express,
  db: DB,
  options: { preview: boolean; production: boolean; origin?: string },
) {
  const cookieOptions = sessionCookieOptions(options);
  function newSession(req: Request, res: Response, userId: string) {
    return issueSession(db, req, res, userId, cookieOptions);
  }
  app.use('/api', (req, _res, next) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token === 'string') {
      const row = one(
        db,
        'SELECT * FROM auth_sessions WHERE token_hash=? AND expires_at>?',
        sha(token),
        now(),
      );
      if (row) {
        const user = actorFor(db, row.user_id);
        if (user) {
          req.actor = { ...user, ip: req.ip, device: String(req.headers['user-agent'] ?? '') };
          req.csrf = row.csrf_token;
          req.sessionHash = row.token_hash;
        }
      }
    }
    const rejection = rejectUnsafeWrite(req, options);
    if (rejection) return next(rejection);
    next();
  });
  app.get('/api/auth/me', (req, res) => {
    res.json({
      user: req.actor ?? null,
      csrf: req.csrf ?? null,
      preview: options.preview,
      business: req.actor ? one(db, 'SELECT * FROM businesses WHERE id=?', req.actor.business_id) : null,
      branch: req.actor ? one(db, 'SELECT * FROM branches WHERE id=?', req.actor.branch_id) : null,
    });
  });
  const loginLimit = rateLimit({
    windowMs: AUTH_WINDOW_MS,
    limit: LOGIN_ATTEMPT_LIMIT,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' },
  });
  app.post('/api/auth/login', loginLimit, (req, res) => {
    const body = loginBody.parse(req.body);
    const email = body.email.toLowerCase();
    const attempt = one(db, 'SELECT * FROM login_attempts WHERE email=?', email);
    requireThat(
      !attempt?.locked_until || attempt.locked_until <= now(),
      'Sign-in is temporarily locked. Try again in 15 minutes.',
      429,
    );
    const user = one(db, 'SELECT * FROM users WHERE email=? COLLATE NOCASE AND active=1', email);
    if (!verifyPassword(body.password, user?.password_hash ?? DUMMY_HASH) || !user) {
      const expired =
        attempt &&
        (Date.parse(attempt.updated_at) + AUTH_WINDOW_MS <= Date.now() ||
          (attempt.locked_until && attempt.locked_until <= now()));
      const failures = (expired ? 0 : (attempt?.failures ?? 0)) + 1;
      db.prepare(
        'INSERT INTO login_attempts VALUES(?,?,?,?) ON CONFLICT(email) DO UPDATE SET failures=excluded.failures,locked_until=excluded.locked_until,updated_at=excluded.updated_at',
      ).run(email, failures, failures >= LOCKOUT_FAILURES ? expiresAt(LOCKOUT_MS) : null, now());
      if (user)
        audit(
          db,
          { ...actorFor(db, user.id)!, ip: req.ip, device: String(req.headers['user-agent'] ?? '') },
          'auth.login_failed',
          'users',
          user.id,
          null,
          null,
          'Invalid credentials',
        );
      throw new AppError(401, 'Email or password is incorrect.');
    }
    if (!user.password_hash.startsWith('scrypt-v2:')) {
      db.transaction(() => {
        db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(body.password), user.id);
        audit(
          db,
          { ...actorFor(db, user.id)!, ip: req.ip },
          'auth.password_rehashed',
          'users',
          user.id,
          null,
          { scheme: 'scrypt-v2' },
          'Upgrade legacy password derivation after successful authentication',
        );
      }).immediate();
    }
    db.prepare('DELETE FROM login_attempts WHERE email=?').run(email);
    const csrf = newSession(req, res, user.id);
    audit(
      db,
      { ...actorFor(db, user.id)!, ip: req.ip, device: String(req.headers['user-agent'] ?? '') },
      'auth.login',
      'users',
      user.id,
      null,
      null,
      'Password sign-in',
    );
    res.json({ csrf, user: actorFor(db, user.id) });
  });
  if (options.preview)
    app.post('/api/auth/preview', loginLimit, (req, res) => {
      const owner = one(db, "SELECT id FROM users WHERE role_id='super_admin' ORDER BY created_at LIMIT 1");
      requireThat(owner, 'Preview workspace is not initialised.', 503);
      const csrf = newSession(req, res, owner.id);
      audit(
        db,
        { ...actorFor(db, owner.id)!, ip: req.ip, device: String(req.headers['user-agent'] ?? '') },
        'auth.preview_login',
        'users',
        owner.id,
        null,
        null,
        'Isolated development preview; never for production',
      );
      res.json({ csrf, user: actorFor(db, owner.id) });
    });
  app.post('/api/auth/logout', (req, res) => {
    if (req.actor) {
      db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(req.sessionHash);
      audit(db, req.actor, 'auth.logout', 'users', req.actor.id, null, null, 'User signed out');
    }
    res.clearCookie(SESSION_COOKIE, { ...cookieOptions, maxAge: undefined }).json({ ok: true });
  });
  const passwordLimit = rateLimit({
    windowMs: AUTH_WINDOW_MS,
    limit: PASSWORD_ATTEMPT_LIMIT,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many password-change attempts. Try again later.' },
  });
  app.post('/api/auth/password', passwordLimit, (req, res) => {
    requireThat(req.actor, 'Sign in first.', 401);
    const body = passwordChangeBody.parse(req.body);
    const user = one(db, 'SELECT * FROM users WHERE id=?', req.actor.id)!;
    requireThat(verifyPassword(body.current, user.password_hash), 'Current password is incorrect.', 400);
    requireThat(body.current !== body.password, 'Choose a different password.');
    const csrf = db
      .transaction(() => {
        db.prepare('UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?').run(
          hashPassword(body.password),
          user.id,
        );
        db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(user.id);
        audit(
          db,
          req.actor,
          'auth.password_changed',
          'users',
          user.id,
          null,
          { sessions_revoked: true },
          'User password change',
        );
        return newSession(req, res, user.id);
      })
      .immediate();
    res.json({ csrf, user: actorFor(db, user.id) });
  });
}
