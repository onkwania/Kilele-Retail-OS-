import 'dotenv/config';
import express from 'express';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createDb, bootstrap } from './db.js';
import { one } from './core.js';
import { createApp } from './app.js';
const production = process.env.NODE_ENV === 'production';
const preview = process.env.PREVIEW_MODE === 'true';
if (production && preview) throw new Error('Preview mode is prohibited in production.');
const db = createDb(process.env.DATABASE_PATH ?? './data/kilele.sqlite');
if (!one(db, 'SELECT id FROM users LIMIT 1')) {
  if (!preview) throw new Error('Run npm run bootstrap with owner credentials before starting the server.');
  bootstrap(db, { name: 'Workspace Owner', email: 'owner@preview.kilele.local', password: randomBytes(36).toString('base64url'), business: 'Kilele Bottle Store' });
}
const app = createApp(db, { production, preview, origin: process.env.APP_ORIGIN });
if (production) {
  app.use(express.static(resolve('dist/client'), { index: false, maxAge: '1h' }));
  app.get('/{*path}', (_req,res) => res.sendFile(resolve('dist/client/index.html')));
}
const server = app.listen(Number(process.env.PORT ?? 3001), '0.0.0.0', () => console.log(`Kilele API listening on 0.0.0.0:${process.env.PORT ?? 3001} (${preview ? 'ISOLATED PREVIEW — no real data' : 'authenticated workspace'})`));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => { server.close(() => { db.close(); process.exit(0); }); });
