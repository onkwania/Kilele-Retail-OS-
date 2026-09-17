import express from 'express';
import {
  installErrorHandling,
  installSecurityMiddleware,
  validateAppOptions,
  type AppOptions,
} from '../app-shared.js';
import { convertedSlices, engine, ping } from './db.js';
import { pendingSlices } from './slices.js';

/**
 * The PostgreSQL HTTP surface - Slice 1 of the migration (health and connection).
 *
 * Security middleware and the error contract are shared with the SQLite app, so a client cannot
 * tell which engine is serving it. What differs is coverage: only converted slices have routes.
 * Every other API path answers **503 NOT_MIGRATED** rather than 404 or, worse, a plausible-looking
 * empty response. Failing closed is the point - during the migration a half-converted server must
 * never look healthy while silently refusing to record money.
 */

export function createPostgresApp(options: AppOptions = {}): express.Express {
  validateAppOptions(options);
  if (engine() !== 'postgres') {
    throw new Error(
      `createPostgresApp requires DATABASE_ENGINE=postgres (received "${engine()}"). Refusing to serve a PostgreSQL app on top of the SQLite configuration.`,
    );
  }
  const app = express();
  installSecurityMiddleware(app, options);

  // --- Slice 1: health and connection -----------------------------------------------------
  // A real round trip, not a static string: if the pool cannot reach the database the till must
  // show that immediately instead of accepting sales it cannot store.
  app.get('/api/health', async (_req, res) => {
    try {
      await ping();
      res.json({ status: 'ok', currency: 'KES', database: 'available', engine: 'postgres' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[health] database round trip failed:', message);
      res.status(503).json({
        status: 'error',
        currency: 'KES',
        database: 'unreachable',
        engine: 'postgres',
        error: 'The database is unreachable. No transaction can be recorded right now.',
      });
    }
  });

  // Operator diagnostics for the migration itself: which slices are live and which are not.
  app.get('/api/engine', (_req, res) => {
    res.json({ engine: 'postgres', migrated: convertedSlices(), pending: pendingSlices() });
  });

  // --- Everything not yet converted fails closed -------------------------------------------
  app.use('/api', (req, res) => {
    res.status(503).json({
      error: 'This operation is not available yet: the PostgreSQL migration has not converted this route.',
      code: 'NOT_MIGRATED',
      route: `${req.method} ${req.originalUrl.split('?')[0]}`,
      migrated: convertedSlices(),
    });
  });

  installErrorHandling(app);
  return app;
}
