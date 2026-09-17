import express from 'express';
import { guardEnvironment } from './environment.js';
import { z } from 'zod';
import { mutate } from './mutate.js';
import { financialOperation } from '../shared/operations.js';
import {
  installApiNotFound,
  installErrorHandling,
  installSecurityMiddleware,
  validateAppOptions,
  type AppOptions,
} from './app-shared.js';
import {
  type DB,
  integrity,
  one,
  requireThat,
  sha,
  insert,
  scope,
  now,
  audit,
  reasonInput,
  demand,
} from './core.js';
import { installManagement } from './management.js';
import { installInvites } from './invites.js';
import { installReports } from './reports.js';
import { installAnalytics } from './analytics.js';
import { installApprovals } from './approvals.js';
import { installExpenses } from './expenses.js';
import { installInventory } from './inventory.js';
import { installSales } from './sales.js';
import { installProducts } from './products.js';
import { installAuth, protect } from './auth.js';
export type { AppOptions };

/**
 * The SQLite HTTP surface. Security middleware and the error contract come from
 * server/app-shared.ts so the PostgreSQL app (server/postgres/app.ts) behaves identically.
 */
export function createApp(db: DB, options: AppOptions = {}) {
  validateAppOptions(options);
  guardEnvironment(db, options.preview ?? false, options.production ?? false);
  const app = express();
  installSecurityMiddleware(app, options);
  installAuth(app, db, {
    preview: options.preview ?? false,
    production: options.production ?? false,
    origin: options.origin,
  });
  app.get('/api/health', (_req, res) => {
    one(db, 'SELECT 1 value');
    res.json({ status: 'ok', currency: 'KES', database: 'available' });
  });
  app.get('/api/integrity', protect('audit.read'), (req, res) => res.json(integrity(db, req.actor)));
  app.get('/api/operations/:key', protect(), (req, res) => {
    const row = one(
      db,
      'SELECT route,response_json,created_at FROM idempotency_keys WHERE user_id=? AND business_id=? AND branch_id=? AND key=?',
      req.actor.id,
      req.actor.business_id,
      req.actor.branch_id,
      req.params.key,
    );
    if (row) {
      const rule = financialOperation(row.route.split(' ')[0], row.route.split(' ')[1].replace(/^\/api/, ''));
      requireThat(rule, 'This operation is not a recoverable financial submission.', 404);
      demand(req.actor, rule.permission);
    }
    const result = row ? JSON.parse(row.response_json) : null;
    res.json(
      row
        ? { state: result.cancelled ? 'cancelled' : 'posted', created_at: row.created_at, result }
        : { state: 'not_found' },
    );
  });
  app.post('/api/operations/:key/cancel', protect(), (req, res) => {
    const key = String(req.params.key),
      body = z
        .object({
          original: z.record(z.string(), z.unknown()).optional(),
          reason: reasonInput,
          method: z.literal('POST').default('POST'),
          path: z.string().max(200).default('/sales'),
        })
        .strict()
        .parse(req.body);
    const rule = financialOperation(body.method, body.path);
    requireThat(rule, 'Unsupported financial submission.', 400);
    demand(req.actor, rule.permission);
    const originalRoute = `${body.method} /api${body.path}`;
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
          hash = sha(body.original ? JSON.stringify(body.original) : `cancelled-key:${key}`);
        if (previous) {
          requireThat(
            previous.business_id === req.actor.business_id &&
              previous.branch_id === req.actor.branch_id &&
              previous.route === originalRoute &&
              (body.original === undefined ||
                JSON.parse(previous.response_json).cancelled ||
                previous.request_hash === hash),
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
          route: originalRoute,
          request_hash: hash,
          response_json: JSON.stringify({ cancelled: true, reason: body.reason }),
          created_at: now(),
        });
        audit(
          db,
          req.actor,
          'submission.cancelled_unposted',
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
  installInvites(app, db, {
    preview: options.preview ?? false,
    production: options.production ?? false,
  });
  // DOMAIN_ROUTES
  installApiNotFound(app);
  installErrorHandling(app);
  return app;
}
