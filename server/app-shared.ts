import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { ZodError } from 'zod';
import { AppError } from './core.js';

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
 * Storage-engine constraint failures that mean the same thing to a client: the write was refused
 * by a database-level guard, nothing partial was stored, and the operator should refresh and
 * check references. SQLite reports `SQLITE_CONSTRAINT*`; PostgreSQL reports SQLSTATE classes
 * 23xxx plus `P0001`, which is what a guard trigger's `RAISE EXCEPTION` produces.
 */
const PG_CONSTRAINT_CODES = new Set(['23502', '23503', '23505', '23514', 'P0001']);

export function isConstraintError(err: { code?: string }): boolean {
  if (typeof err?.code !== 'string') return false;
  return err.code.startsWith('SQLITE_CONSTRAINT') || PG_CONSTRAINT_CODES.has(err.code);
}

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
