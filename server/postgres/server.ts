import 'dotenv/config';
import express from 'express';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import type { AppOptions } from '../app-shared.js';
import { closePool, engine, ping } from './db.js';
import { migrate, pendingMigrations } from './migrate.js';
import { assertProtections } from './integrity.js';
import { createPostgresApp } from './app.js';
import { markSliceConverted } from './slices.js';

/**
 * PostgreSQL startup - Slice 1 of the migration (health and connection).
 *
 * Boot order matters, because each step is a chance to fail clearly instead of half-starting:
 *   1. prove the connection works, with an operator-readable explanation when it does not;
 *   2. apply (or verify) the migrations that live in Git;
 *   3. prove every financial protection is installed before accepting a single request;
 *   4. only then listen.
 *
 * No SQLite file is opened, created or read on this path: `createDb` is never imported here, and
 * `DATABASE_PATH` is ignored. The engine guard in server/db.ts makes the reverse mistake
 * (claiming postgres while opening SQLite) impossible too.
 */

// Slice 1 is implemented by this module and the PostgreSQL app.
markSliceConverted('health');

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
  info: { version: string; database: string; migrationsApplied: string[]; protections: number };
  close: () => Promise<void>;
};

/** Turns a driver error into the action an operator needs to take. */
export function explainConnectionFailure(error: unknown): string {
  const code = (error as { code?: string })?.code ?? '';
  // A plain object is not an Error, but pg wraps some failures that way; never print
  // "[object Object]" to an operator trying to diagnose a deploy.
  const message =
    error instanceof Error
      ? error.message
      : String((error as { message?: string })?.message ?? JSON.stringify(error) ?? '');
  if (code === '28P01') {
    return (
      'PostgreSQL rejected the credentials in DATABASE_URL (SQLSTATE 28P01). Copy the connection string ' +
      "from the database provider's own dashboard, keep it in the server environment only, and never in a VITE_* variable."
    );
  }
  // Checked before the generic 28000 branch: "no pg_hba.conf entry ... no encryption" is the
  // classic symptom of a server that requires TLS, not of a wrong password.
  if (/pg_hba|no encryption|SSL|TLS/i.test(message)) {
    return (
      `The database refused this connection's transport security (${message}). Supabase requires TLS: ` +
      'set DATABASE_SSL=require, or verify-full when the platform CA bundle is installed.'
    );
  }
  if (code === '28000') {
    return (
      `PostgreSQL refused the role or database in DATABASE_URL (SQLSTATE 28000: ${message}). ` +
      'Check the role name, and that it is allowed to connect from this host.'
    );
  }
  if (code === '3D000') return `The database named in DATABASE_URL does not exist (${message}).`;
  if (code === 'ENOTFOUND')
    return `Cannot resolve the database host in DATABASE_URL (${message}). Check the hostname and DNS egress from this host.`;
  if (code === 'ECONNREFUSED')
    return `Nothing accepted the connection to the database host (${message}). Check the port, and whether the provider requires the client IP to be allow-listed.`;
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET')
    return `The database connection timed out or was reset (${message}). Check the network path, and use the provider's pooled host if this service runs behind a connection limit.`;
  return `Could not connect to PostgreSQL: ${message}`;
}

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
      `${protections.counts.triggers} guard triggers verified, migrations applied at boot: ${migrationsApplied.length}). ` +
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
    },
    close,
  };
}
