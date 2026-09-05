import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { ZodError } from 'zod';
import { type DB, AppError, integrity } from './core.js';
import { installSales } from './sales.js';
import { installProducts } from './products.js';
import { installAuth, protect } from './auth.js';
export type AppOptions = { preview?: boolean; production?: boolean; origin?: string };
export function createApp(db: DB, options: AppOptions = {}) {
  if (options.production && options.preview) throw new Error('Refusing production startup: PREVIEW_MODE must be disabled.');
  if (options.production && (!options.origin || !options.origin.startsWith('https://'))) throw new Error('Production requires an HTTPS APP_ORIGIN.');
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], fontSrc: ["'self'"], connectSrc: ["'self'"], frameAncestors: options.production ? ["'none'"] : ["'self'"] } } }));
  app.use(express.json({ limit: '4mb' }));
  app.use(cookieParser());
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many requests. Please wait a moment.' } }));
  app.use('/api', (_req,res,next) => { res.set('Cache-Control','no-store'); next(); });
  installAuth(app, db, { preview: options.preview ?? false, production: options.production ?? false, origin: options.origin });
  app.get('/api/health', (_req,res) => res.json({ status: 'ok', currency: 'KES' }));
  app.get('/api/integrity', protect('audit.read'), (_req,res) => res.json(integrity(db)));
  installProducts(app,db);
  installSales(app,db);
  // DOMAIN_ROUTES
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof ZodError) return res.status(400).json({ error: err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '), code: 'VALIDATION_ERROR' });
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err.code?.startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'This action conflicts with an existing record or an accounting constraint. Refresh and check references before retrying.', code: 'CONFLICT' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Document or request is too large.' });
    if (err instanceof SyntaxError) return res.status(400).json({ error: 'Invalid JSON request.' });
    console.error('Server error', err);
    return res.status(500).json({ error: 'The operation could not be completed. No partial transaction was saved.', code: 'INTERNAL_ERROR' });
  });
  return app;
}
