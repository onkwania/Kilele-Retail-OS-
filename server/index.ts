import 'dotenv/config';
import express from 'express';
import { guardEnvironment } from './environment.js';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { seedCatalogue } from './catalogue.js';
import { actorFor, createDb, bootstrap } from './db.js';
import { one } from './core.js';
import { createApp } from './app.js';
const production = process.env.NODE_ENV === 'production';
const preview = process.env.PREVIEW_MODE === 'true';
if (production && preview) throw new Error('Preview mode is prohibited in production.');
const db = createDb(process.env.DATABASE_PATH ?? './data/kilele.sqlite');
guardEnvironment(db, preview, production);
if (!one(db, 'SELECT id FROM users LIMIT 1')) {
  if (preview) {
    bootstrap(db, {
      name: 'Workspace Owner',
      email: 'owner@preview.kilele.local',
      password: randomBytes(36).toString('base64url'),
      business: 'Kilele Bottle Store',
    });
  } else {
    const name = process.env.BOOTSTRAP_NAME;
    const email = process.env.BOOTSTRAP_EMAIL;
    const password = process.env.BOOTSTRAP_PASSWORD;
    const business = process.env.BUSINESS_NAME;
    if (
      !name ||
      name.length < 2 ||
      !email ||
      !email.includes('@') ||
      !password ||
      password.length < 12 ||
      !business ||
      business.length < 2
    )
      throw new Error(
        'Production database is uninitialised. Set BOOTSTRAP_NAME, BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD (minimum 12 characters), and BUSINESS_NAME once, then restart.',
      );
    bootstrap(db, { name, email, password, business });
    console.log(
      `Workspace bootstrapped for ${email}. Remove BOOTSTRAP_NAME, BOOTSTRAP_EMAIL, and BOOTSTRAP_PASSWORD.`,
    );
  }
}
seedCatalogue(db, actorFor(db, one(db, "SELECT id FROM users WHERE role_id='super_admin' LIMIT 1")!.id)!);
const proxy = process.env.TRUST_PROXY;
const trustProxy = proxy
  ? /^\d+$/.test(proxy)
    ? Number(proxy)
    : proxy.split(',').map((v) => v.trim())
  : undefined;
const app = createApp(db, { production, preview, origin: process.env.APP_ORIGIN, trustProxy });
if (production) {
  app.use(express.static(resolve('dist/client'), { index: false, maxAge: '1h' }));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/client/index.html')));
}
const server = app.listen(Number(process.env.PORT ?? 3001), '0.0.0.0', () =>
  console.log(
    `Kilele API listening on 0.0.0.0:${process.env.PORT ?? 3001} (${preview ? 'ISOLATED PREVIEW — no real data' : 'authenticated workspace'})`,
  ),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
