import type { Request, Response, NextFunction, Express } from 'express';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { type Actor, type DB, AppError, audit, now, one, sha, requireThat, demand } from './core.js';
import { actorFor, hashPassword } from './db.js';

declare module 'express-serve-static-core' {
  interface Request {
    actor: Actor;
    csrf: string;
    sessionHash: string;
  }
}
const DUMMY_HASH = hashPassword('dummy-password-not-used');
export function verifyPassword(password: string, stored: string) {
  const [salt, key] = stored.split(':');
  const computed = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(Buffer.from(key, 'hex'), computed);
}
export function protect(permission?: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.actor) return next(new AppError(401, 'Please sign in to continue.', 'UNAUTHENTICATED'));
    if (req.actor.must_change_password)
      return next(
        new AppError(403, 'Change your temporary password before continuing.', 'PASSWORD_CHANGE_REQUIRED'),
      );
    if (permission) demand(req.actor, permission);
    next();
  };
}
export function installAuth(
  app: Express,
  db: DB,
  options: { preview: boolean; production: boolean; origin?: string },
) {
  // Isolated embedded previews need a secure partitioned cookie; production remains first-party SameSite=Strict.
  const cookieOptions = {
    httpOnly: true,
    secure: options.production || options.preview,
    sameSite: options.preview ? ('none' as const) : ('strict' as const),
    partitioned: options.preview,
    path: '/',
    maxAge: 12 * 3600_000,
  };
  function newSession(req: Request, res: Response, userId: string) {
    if (req.sessionHash) db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(req.sessionHash);
    const token = randomBytes(32).toString('hex'),
      csrf = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO auth_sessions VALUES(?,?,?,?,?,?,?)').run(
      sha(token),
      userId,
      csrf,
      new Date(Date.now() + 12 * 3600_000).toISOString(),
      now(),
      req.ip ?? '',
      String(req.headers['user-agent'] ?? '').slice(0, 300),
    );
    res.cookie('kilele_session', token, cookieOptions);
    return csrf;
  }
  app.use('/api', (req, _res, next) => {
    const token = req.cookies?.kilele_session;
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
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin) {
        let allowed = origin === options.origin;
        if (!options.production) {
          try {
            const u = new URL(origin);
            allowed ||=
              u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname.endsWith('.e2b.app');
          } catch {
            /* fail closed */
          }
        }
        if (!allowed) return next(new AppError(403, 'Request origin is not allowed.', 'CSRF_REJECTED'));
      }
      if (req.headers['sec-fetch-site'] === 'cross-site')
        return next(new AppError(403, 'Cross-site request blocked.'));
      if (
        req.actor &&
        req.path !== '/auth/login' &&
        req.path !== '/auth/preview' &&
        req.headers['x-csrf-token'] !== req.csrf
      )
        return next(
          new AppError(403, 'Security token is missing or expired. Refresh and try again.', 'CSRF_REJECTED'),
        );
    }
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
    windowMs: 15 * 60_000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' },
  });
  app.post('/api/auth/login', loginLimit, (req, res) => {
    const body = z
      .object({ email: z.string().email().max(200), password: z.string().min(1).max(200) })
      .strict()
      .parse(req.body);
    const email = body.email.toLowerCase();
    const attempt = one(db, 'SELECT * FROM login_attempts WHERE email=?', email);
    requireThat(
      !attempt?.locked_until || attempt.locked_until <= now(),
      'Sign-in is temporarily locked. Try again in 15 minutes.',
      429,
    );
    const user = one(db, 'SELECT * FROM users WHERE email=? COLLATE NOCASE AND active=1', email);
    if (!verifyPassword(body.password, user?.password_hash ?? DUMMY_HASH) || !user) {
      const failures = (attempt?.failures ?? 0) + 1;
      db.prepare(
        'INSERT INTO login_attempts VALUES(?,?,?,?) ON CONFLICT(email) DO UPDATE SET failures=excluded.failures,locked_until=excluded.locked_until,updated_at=excluded.updated_at',
      ).run(email, failures, failures >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null, now());
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
    res.clearCookie('kilele_session', { ...cookieOptions, maxAge: undefined }).json({ ok: true });
  });
  app.post('/api/auth/password', (req, res) => {
    requireThat(req.actor, 'Sign in first.', 401);
    const body = z
      .object({ current: z.string().max(200), password: z.string().min(12).max(200) })
      .strict()
      .parse(req.body);
    const user = one(db, 'SELECT * FROM users WHERE id=?', req.actor.id)!;
    requireThat(verifyPassword(body.current, user.password_hash), 'Current password is incorrect.', 400);
    requireThat(body.current !== body.password, 'Choose a different password.');
    db.transaction(() => {
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
    }).immediate();
    res.json({ csrf: newSession(req, res, user.id), user: actorFor(db, user.id) });
  });
}
