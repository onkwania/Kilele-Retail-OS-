import 'dotenv/config';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import type { AppOptions } from '../app-shared.js';
import { closePool, engine, getPool, ping } from './db.js';
import { migrate, pendingMigrations } from './migrate.js';
import { assertProtections } from './integrity.js';
import { createPostgresApp } from './app.js';
import { explainConnectionFailure } from '../db-errors.js';
import { createWorkspace, seedReferenceData } from './bootstrap.js';
import { guardEnvironment, type EnvironmentReport } from './environment.js';
import { one } from './query.js';
import { transaction } from './transaction.js';

/**
 * PostgreSQL startup - Slice 1 (health and connection) and Slice 2 (bootstrap and authentication).
 *
 * Boot order matters, because each step is a chance to fail clearly instead of half-starting:
 *   1. prove the connection works, with an operator-readable explanation when it does not;
 *   2. apply (or verify) the migrations that live in Git;
 *   3. prove every financial protection is installed before accepting a single request;
 *   4. seed the role/permission reference data, classify the environment's provenance and create
 *      the owner workspace exactly once - the same three decisions server/index.ts makes for the
 *      SQLite ledger, in the same order, with the same wording;
 *   5. only then listen.
 *
 * No SQLite file is opened, created or read on this path: `createDb` is never imported here, and
 * `DATABASE_PATH` is ignored. The engine guard in server/db.ts makes the reverse mistake
 * (claiming postgres while opening SQLite) impossible too.
 */

export type PostgresStartupOptions = AppOptions & {
  port?: number;
  host?: string;
  /** Serve the built client, as production SQLite mode does. */
  serveClient?: boolean;
  /** Apply pending migrations at boot. Defaults to true outside production. */
  autoMigrate?: boolean;
  /** Install SIGINT/SIGTERM handlers. Tests pass false so they stay in control of shutdown. */
  installSignalHandlers?: boolean;
};

export type RunningServer = {
  server: Server;
  url: string;
  port: number;
  info: {
    version: string;
    database: string;
    migrationsApplied: string[];
    protections: number;
    environment: EnvironmentReport;
    workspace: 'created' | 'already-present';
    seeded: { permissions: number; roles: number; rolePermissions: number };
  };
  close: () => Promise<void>;
};

// Connection diagnosis is shared with the HTTP error contract in server/db-errors.ts, so a failed
// startup and a failed request explain the same failure the same way. Re-exported for callers and
// tests that reach it through the startup module.
export { explainConnectionFailure };

/** One round trip, so credentials, TLS, host and database are all proven before anything listens. */
export async function verifyConnection(): Promise<{ version: string; database: string }> {
  if (engine() !== 'postgres') {
    throw new Error(`verifyConnection requires DATABASE_ENGINE=postgres (received "${engine()}").`);
  }
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_ENGINE=postgres requires DATABASE_URL. Set it to the server-only PostgreSQL connection string.',
    );
  }
  try {
    return await ping();
  } catch (error) {
    throw new Error(explainConnectionFailure(error), { cause: error });
  }
}

function shouldAutoMigrate(options: PostgresStartupOptions): boolean {
  if (options.autoMigrate !== undefined) return options.autoMigrate;
  const configured = process.env.DATABASE_AUTO_MIGRATE?.trim().toLowerCase();
  if (configured === 'true') return true;
  if (configured === 'false') return false;
  // Outside production a developer expects `npm run dev` to bring the schema up to date.
  // In production the release command migrates explicitly, so a rolling restart cannot apply a
  // half-reviewed migration.
  return process.env.NODE_ENV !== 'production';
}

/**
 * Creates the owner workspace if - and only if - the database has no users yet.
 *
 * Mirrors server/index.ts exactly: preview mode generates a throwaway owner for an isolated
 * workspace, and every other mode requires the operator to supply bootstrap credentials once.
 * Only the email is ever logged; the password is never printed, stored in an audit row, or
 * included in an error message.
 */
export async function ensureWorkspace(options: { preview: boolean }): Promise<'created' | 'already-present'> {
  if (await one<{ id: string }>(getPool(), 'SELECT id FROM users LIMIT 1')) return 'already-present';
  if (options.preview) {
    await createWorkspace({
      name: 'Workspace Owner',
      email: 'owner@preview.kilele.local',
      password: randomBytes(36).toString('base64url'),
      business: 'Kilele Bottle Store',
    });
    return 'created';
  }
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
  await createWorkspace({ name, email, password, business });
  console.log(
    `Workspace bootstrapped for ${email}. Remove BOOTSTRAP_NAME, BOOTSTRAP_EMAIL, and BOOTSTRAP_PASSWORD.`,
  );
  return 'created';
}

export async function startPostgresServer(options: PostgresStartupOptions = {}): Promise<RunningServer> {
  const connection = await verifyConnection();

  let migrationsApplied: string[] = [];
  if (shouldAutoMigrate(options)) {
    const result = await migrate();
    migrationsApplied = result.applied;
  } else {
    const pending = await pendingMigrations();
    if (pending.length) {
      throw new Error(
        `The database is missing ${pending.length} migration(s): ${pending.join(', ')}. ` +
          'Run `npm run db:pg:migrate` (or the deploy release command) before starting in production, ' +
          'or set DATABASE_AUTO_MIGRATE=true to apply them at boot.',
      );
    }
  }

  // Never accept a request on a schema whose guards are not installed.
  const protections = await assertProtections();

  const preview = options.preview ?? false;
  const production = options.production ?? false;

  // Reference data first: users.role_id is a foreign key into roles, so a workspace cannot be
  // created before the roles exist. Seeding is idempotent (ON CONFLICT DO NOTHING) and runs in one
  // transaction, so a half-seeded database repairs itself on the next boot.
  const seeded = await transaction((tx) => seedReferenceData(tx));

  // Provenance before anybody can sign in: a preview database must never be promoted to live
  // books, and an operational one must never accept preview authentication.
  const environment = await guardEnvironment({ preview, production });

  const workspace = await ensureWorkspace({ preview });

  const app = createPostgresApp(options);
  if (options.serveClient) {
    app.use(express.static(resolve('dist/client'), { index: false, maxAge: '1h' }));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/client/index.html')));
  }

  const port = options.port ?? Number(process.env.PORT ?? 3001);
  const host = options.host ?? '0.0.0.0';
  const server = await new Promise<Server>((listen) => {
    const started = app.listen(port, host, () => listen(started));
  });
  const bound = server.address();
  const boundPort = typeof bound === 'object' && bound ? bound.port : port;

  const close = async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await closePool();
  };

  if (options.installSignalHandlers !== false) {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => {
        void close().then(() => process.exit(0));
      });
    }
  }

  console.log(
    `Kilele API listening on ${host}:${boundPort} (PostgreSQL ${connection.version.split(' ')[1]} on database "${connection.database}", ` +
      `${protections.counts.triggers} guard triggers verified, migrations applied at boot: ${migrationsApplied.length}, ` +
      `workspace ${workspace}, environment ${environment.markerWritten ?? (preview ? 'preview' : 'unclassified')}). ` +
      'DATABASE_PATH is ignored in this mode: no SQLite file is opened or created.',
  );

  return {
    server,
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${boundPort}`,
    port: boundPort,
    info: {
      version: connection.version,
      database: connection.database,
      migrationsApplied,
      protections: protections.counts.triggers,
      environment,
      workspace,
      seeded,
    },
    close,
  };
}
