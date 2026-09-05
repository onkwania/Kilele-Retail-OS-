import express from 'express';
import { guardEnvironment } from './environment.js';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { ZodError, z } from 'zod';
import { mutate } from './mutate.js';
import {
  type DB,
  AppError,
  integrity,
  one,
  requireThat,
  sha,
  insert,
  scope,
  now,
  audit,
  reasonInput,
} from './core.js';
import { installManagement } from './management.js';
import { installReports } from './reports.js';
import { installAnalytics } from './analytics.js';
import { installApprovals } from './approvals.js';
import { installExpenses } from './expenses.js';
import { installInventory } from './inventory.js';
import { installSales } from './sales.js';
import { installProducts } from './products.js';
import { installAuth, protect } from './auth.js';
export type AppOptions = {
  preview?: boolean;
  production?: boolean;
  origin?: string;
  trustProxy?: number | string[];
};
export function createApp(db: DB, options: AppOptions = {}) {
  if (options.production && options.preview)
    throw new Error('Refusing production startup: PREVIEW_MODE must be disabled.');
  if (options.production && (!options.origin || !options.origin.startsWith('https://')))
    throw new Error('Production requires an HTTPS APP_ORIGIN.');
  guardEnvironment(db, options.preview ?? false, options.production ?? false);
  const app = express();
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
  installAuth(app, db, {
    preview: options.preview ?? false,
    production: options.production ?? false,
    origin: options.origin,
  });
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', currency: 'KES' }));
  app.get('/api/integrity', protect('audit.read'), (_req, res) => res.json(integrity(db)));
  app.get('/api/operations/:key', protect('sales.create'), (req, res) => {
    const row = one(
      db,
      "SELECT route,response_json,created_at FROM idempotency_keys WHERE user_id=? AND business_id=? AND branch_id=? AND key=? AND route='POST /api/sales'",
      req.actor.id,
      req.actor.business_id,
      req.actor.branch_id,
      req.params.key,
    );
    const result = row ? JSON.parse(row.response_json) : null;
    res.json(
      row
        ? { state: result.cancelled ? 'cancelled' : 'posted', created_at: row.created_at, result }
        : { state: 'not_found' },
    );
  });
  app.post('/api/operations/:key/cancel', protect('sales.create'), (req, res) => {
    const key = String(req.params.key),
      body = z
        .object({ original: z.record(z.string(), z.unknown()), reason: reasonInput })
        .strict()
        .parse(req.body);
    requireThat(
      /^[\w-]{16,100}$/.test(key) && key !== req.headers['idempotency-key'],
      'Use distinct valid keys for the original sale and the cancellation.',
    );
    res.json(
      mutate(db, req, () => {
        const previous = one(
            db,
            'SELECT * FROM idempotency_keys WHERE user_id=? AND key=?',
            req.actor.id,
            key,
          ),
          hash = sha(JSON.stringify(body.original));
        if (previous) {
          requireThat(
            previous.route === 'POST /api/sales' && previous.request_hash === hash,
            'This key belongs to a different submission.',
            409,
          );
          const result = JSON.parse(previous.response_json);
          return { state: result.cancelled ? 'cancelled' : 'posted', result };
        }
        insert(db, 'idempotency_keys', {
          ...scope(req.actor),
          user_id: req.actor.id,
          key,
          route: 'POST /api/sales',
          request_hash: hash,
          response_json: JSON.stringify({ cancelled: true, reason: body.reason }),
          created_at: now(),
        });
        audit(
          db,
          req.actor,
          'checkout.cancelled_unposted',
          'idempotency_keys',
          key,
          null,
          { cancelled: true },
          body.reason,
        );
        return { state: 'cancelled' };
      }),
    );
  });
  installProducts(app, db);
  installSales(app, db);
  installInventory(app, db);
  installExpenses(app, db);
  installApprovals(app, db);
  installAnalytics(app, db);
  installReports(app, db);
  installManagement(app, db);
  // DOMAIN_ROUTES
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof ZodError)
      return res.status(400).json({
        error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        code: 'VALIDATION_ERROR',
      });
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err.code?.startsWith('SQLITE_CONSTRAINT'))
      return res.status(409).json({
        error:
          'This action conflicts with an existing record or an accounting constraint. Refresh and check references before retrying.',
        code: 'CONFLICT',
      });
    if (err.type === 'entity.too.large')
      return res.status(413).json({ error: 'Document or request is too large.' });
    if (err instanceof SyntaxError) return res.status(400).json({ error: 'Invalid JSON request.' });
    console.error('Server error', err);
    return res.status(500).json({
      error: 'The operation could not be completed. No partial transaction was saved.',
      code: 'INTERNAL_ERROR',
    });
  });
  return app;
}
