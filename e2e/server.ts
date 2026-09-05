import express from 'express';
import { createServer as createHttpsServer } from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createDb, bootstrap } from '../server/db.js';
import { guardEnvironment } from '../server/environment.js';
import { seedCatalogue } from '../server/catalogue.js';
import { createApp } from '../server/app.js';
// A fresh in-memory fixture, never the preview / production database. No financial values are seeded.
const db = createDb();
guardEnvironment(db, true, false);
const owner = bootstrap(db, {
  name: 'Acceptance Test Owner',
  email: 'qa.owner@preview.kilele.local',
  password: 'unusable-test-only-owner-passphrase',
  business: 'Isolated acceptance test business',
});
seedCatalogue(db, owner);
const app = createApp(db, { preview: true });
app.get('/__acceptance/embed', (_req, res) =>
  res
    .set(
      'Content-Security-Policy',
      "default-src 'none'; frame-src https://127.0.0.1:4174; style-src 'unsafe-inline'",
    )
    .send(
      '<!doctype html><html lang="en"><title>Embedded acceptance harness</title><iframe title="Retail workspace" style="width:1400px;height:1000px" src="https://127.0.0.1:4174/"></iframe></html>',
    ),
);
app.use(express.static(resolve('dist/client')));
app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/client/index.html')));
const tlsDir = mkdtempSync(join(tmpdir(), 'kilele-e2e-tls-'));
const key = join(tlsDir, 'key.pem'),
  cert = join(tlsDir, 'cert.pem');
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-keyout',
    key,
    '-out',
    cert,
    '-days',
    '1',
    '-nodes',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ],
  { stdio: 'ignore' },
);
const tlsServer = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, app).listen(
  4174,
  '0.0.0.0',
);
const productionDb = createDb();
const productionOwner = bootstrap(productionDb, {
  name: 'Production-mode Test Owner',
  email: 'production-test@example.test',
  password: 'production-mode-test-only-password',
});
seedCatalogue(productionDb, productionOwner);
const productionApp = createApp(productionDb, { production: true, origin: 'https://127.0.0.1:4175' });
productionApp.use(express.static(resolve('dist/client')));
productionApp.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/client/index.html')));
const productionServer = createHttpsServer(
  { key: readFileSync(key), cert: readFileSync(cert) },
  productionApp,
).listen(4175, '0.0.0.0');
const server = app.listen(4173, '0.0.0.0', () =>
  console.log('Isolated in-memory acceptance workspace listening on 4173'),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () =>
    server.close(() =>
      tlsServer.close(() =>
        productionServer.close(() => {
          db.close();
          productionDb.close();
          rmSync(tlsDir, { recursive: true, force: true });
          process.exit(0);
        }),
      ),
    ),
  );
