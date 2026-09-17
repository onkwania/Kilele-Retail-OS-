import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { ZodError } from 'zod';
import { AppError } from './core.js';
import { explainConnectionFailure, isConnectionError, isConstraintError } from './db-errors.js';

// Re-exported so existing imports from this module keep working; the classification itself lives
// in server/db-errors.ts where both engines and the startup diagnostics share it.
export { isConstraintError, isConnectionError };

/**
 * Engine-independent parts of the HTTP layer.
 *
 * Security headers, body limits, rate limiting and the error contract are identical whether the
 * ledger lives in SQLite or PostgreSQL, so they are defined once here and used by both
 * `server/app.ts` (SQLite) and `server/postgres/app.ts` (PostgreSQL). A client must not be able
 * to tell which storage engine is behind the API, and a security fix must not have to be applied
 * twice.
 */

export type AppOptions = {
  preview?: boolean;
  production?: boolean;
  origin?: string;
  trustProxy?: number | string[];
};

/** Startup validation: preview and production are mutually exclusive, and production needs an exact HTTPS origin. */
export function validateAppOptions(options: AppOptions): void {
  if (options.production && options.preview)
    throw new Error('Refusing production startup: PREVIEW_MODE must be disabled.');
  if (options.production && (!options.origin || !options.origin.startsWith('https://')))
    throw new Error('Production requires an HTTPS APP_ORIGIN.');
  if (options.production) {
    let valid = false;
    try {
      const origin = new URL(options.origin!);
      valid =
        origin.protocol === 'https:' &&
        origin.origin === options.origin &&
        !origin.username &&
        !origin.password &&
        !origin.search &&
        !origin.hash;
    } catch {
      /* invalid origin */
    }
    if (!valid)
      throw new Error(
        'APP_ORIGIN must be an exact HTTPS origin, without credentials, path, query or trailing slash.',
      );
  }
}

/** Helmet/CSP, JSON body limit, cookies, API rate limit and the no-store rule for /api. */
export function installSecurityMiddleware(app: express.Express, options: AppOptions): void {
  app.disable('x-powered-by');
  if (options.trustProxy !== undefined) app.set('trust proxy', options.trustProxy);
  app.use(
    helmet({
      xFrameOptions: options.production ? { action: 'deny' } : false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          frameAncestors: options.production ? ["'none'"] : ['*'],
        },
      },
    }),
  );
  app.use(express.json({ limit: '4mb' }));
  app.use(cookieParser());
  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      limit: 600,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'Too many requests. Please wait a moment.' },
    }),
  );
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
}

/**
 * An unreachable or refusing database is reported as 503 DATABASE_UNAVAILABLE, never as a 401 or
 * a 500. A till that cannot reach its ledger must say so: "your password is wrong" would send a
 * cashier into a lockout loop, and "internal error" hides an outage the operator can fix in
 * seconds by checking DATABASE_URL, TLS or the provider's IP allow-list.
 */
const OUTAGE_RESPONSE = {
  error: 'The database is unavailable, so nothing was recorded. Retry once the connection is restored.',
  code: 'DATABASE_UNAVAILABLE',
};

const CONFLICT_RESPONSE = {
  error:
    'This action conflicts with an existing record or an accounting constraint. Refresh and check references before retrying.',
  code: 'CONFLICT',
};

/** The single error contract for every route, on either engine. */
export function installErrorHandling(app: express.Express): void {
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof ZodError)
      return res.status(400).json({
        error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        code: 'VALIDATION_ERROR',
      });
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (isConnectionError(err)) {
      // The diagnosis goes to the operator's log; the client gets a retryable outage and nothing
      // that could leak the connection string or a credential.
      console.error('[database] connection failure:', explainConnectionFailure(err));
      return res.status(503).json(OUTAGE_RESPONSE);
    }
    if (isConstraintError(err)) {
      // The database refused the write. The precise guard is logged for operators and never
      // returned, so a rejected write cannot be used to probe the schema.
      if (!String(err.code ?? '').startsWith('SQLITE_'))
        console.error('Database guard refused a write:', err.message);
      return res.status(409).json(CONFLICT_RESPONSE);
    }
    if (err.type === 'entity.too.large')
      return res.status(413).json({ error: 'Document or request is too large.' });
    if (err instanceof SyntaxError) return res.status(400).json({ error: 'Invalid JSON request.' });
    console.error('Server error', err);
    return res.status(500).json({
      error: 'The operation could not be completed. No partial transaction was saved.',
      code: 'INTERNAL_ERROR',
    });
  });
}

/** Unknown API endpoint. Registered after every real route. */
export function installApiNotFound(app: express.Express): void {
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
}
