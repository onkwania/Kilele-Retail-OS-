import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import request from 'supertest';
import { readdirSync, existsSync } from 'node:fs';
import { closePool, setPool } from '../server/postgres/db.js';
import { migrate } from '../server/postgres/migrate.js';
import { createPostgresApp } from '../server/postgres/app.js';
import {
  explainConnectionFailure,
  startPostgresServer,
  verifyConnection,
} from '../server/postgres/server.js';
import { SLICE_SCOPE, convertedSlices, pendingSlices } from '../server/postgres/slices.js';

/**
 * Slice 1 of the PostgreSQL migration: health and connection.
 *
 * Acceptance criteria from the migration plan, each asserted below:
 *   - the API connects to PostgreSQL and /api/health reports healthy;
 *   - the connection pool opens and closes correctly;
 *   - invalid credentials fail clearly (an operator-readable reason, not a stack trace);
 *   - no SQLite file is created in PostgreSQL mode.
 * Plus the rule that keeps the migration honest: every route that has not been converted answers
 * 503 NOT_MIGRATED instead of pretending to work.
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim() ?? '';
const REQUIRED = process.env.REQUIRE_POSTGRES_TESTS === '1';

if (!DATABASE_URL && REQUIRED) {
  throw new Error('REQUIRE_POSTGRES_TESTS=1 but DATABASE_URL is not set; Slice 1 would not be verified.');
}
if (!DATABASE_URL) {
  console.warn(
    '[postgres-slice1-health] SKIPPED - DATABASE_URL is not set, so the PostgreSQL API startup path was NOT verified.',
  );
}

const describePg = DATABASE_URL ? describe : describe.skip;
const SCHEMA = `kilele_pg_api_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
/** Every migration in Git, so the counts below follow the schema instead of a hardcoded list. */
const MIGRATIONS = readdirSync('server/postgres/migrations')
  .filter((file) => file.endsWith('.sql'))
  .sort();

async function raw(sql: string) {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

/** Every *.sqlite* file visible from the repository root - used to prove none is created. */
function sqliteFiles(): string[] {
  const found: string[] = [];
  for (const dir of ['data', '.']) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) if (/\.sqlite/i.test(entry)) found.push(`${dir}/${entry}`);
  }
  return found.sort();
}

/** Runs `body` with a different DATABASE_URL and a freshly built pool, then restores both. */
async function withDatabaseUrl(url: string, body: () => Promise<void>) {
  const savedUrl = process.env.DATABASE_URL;
  const savedEngine = process.env.DATABASE_ENGINE;
  process.env.DATABASE_URL = url;
  process.env.DATABASE_ENGINE = 'postgres';
  setPool(null);
  try {
    await body();
  } finally {
    process.env.DATABASE_URL = savedUrl;
    if (savedEngine === undefined) delete process.env.DATABASE_ENGINE;
    else process.env.DATABASE_ENGINE = savedEngine;
    await closePool().catch(() => undefined);
    setPool(null);
  }
}

describePg('Slice 1 - PostgreSQL health, connection and fail-closed routing', () => {
  beforeAll(async () => {
    await raw(`CREATE SCHEMA ${SCHEMA}`);
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.DATABASE_ENGINE = 'postgres';
    process.env.DATABASE_SEARCH_PATH = SCHEMA;
    setPool(null);
    await migrate();
  }, 120_000);

  afterAll(async () => {
    await closePool().catch(() => undefined);
    if (DATABASE_URL) await raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    delete process.env.DATABASE_SEARCH_PATH;
    delete process.env.DATABASE_ENGINE;
  });

  beforeEach(() => {
    process.env.DATABASE_ENGINE = 'postgres';
  });

  describe('/api/health', () => {
    it('reports a healthy database after a real round trip', async () => {
      const response = await request(createPostgresApp()).get('/api/health').expect(200);
      expect(response.body).toEqual({
        status: 'ok',
        currency: 'KES',
        database: 'available',
        engine: 'postgres',
      });
    });

    it('keeps the same security headers as the SQLite API', async () => {
      const response = await request(createPostgresApp()).get('/api/health').expect(200);
      expect(response.headers['x-powered-by']).toBeUndefined();
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['content-security-policy']).toContain("default-src 'self'");
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    });

    it('reports an unreachable database as 503 instead of claiming to be healthy', async () => {
      const url = new URL(DATABASE_URL);
      url.port = '1'; // nothing listens here
      await withDatabaseUrl(url.toString(), async () => {
        const response = await request(createPostgresApp()).get('/api/health').expect(503);
        expect(response.body.status).toBe('error');
        expect(response.body.database).toBe('unreachable');
        expect(response.body.engine).toBe('postgres');
      });
    });
  });

  describe('/api/engine', () => {
    it('states which slices are migrated and which are still pending', async () => {
      const response = await request(createPostgresApp()).get('/api/engine').expect(200);
      expect(response.body.engine).toBe('postgres');
      expect(response.body.migrated).toContain('health');
      expect(response.body.migrated).not.toContain('sales');
      const pending = response.body.pending as Array<{ slice: string; scope: string }>;
      expect(pending.map((entry) => entry.slice)).toContain('sales');
      expect(pending.every((entry) => typeof entry.scope === 'string' && entry.scope.length > 0)).toBe(true);
      expect(convertedSlices()).toContain('health');
      expect(pendingSlices().map((entry) => entry.slice)).not.toContain('health');
      expect(SLICE_SCOPE.sales).toMatch(/POS sales/);
    });
  });

  describe('routes that are not converted yet fail closed', () => {
    // Every unconverted route must answer 503 NOT_MIGRATED - including ones that never existed,
    // so nothing can be probed for a shape the PostgreSQL engine does not serve yet.
    const unconvertedRoutes: Array<[string, string]> = [
      ['get', '/api/sales'],
      // Slice 2 converted authentication, so /api/auth/login now answers for real; its own
      // acceptance lives in tests/postgres-slice2-auth.test.ts.
      ['post', '/api/purchases'],
      ['get', '/api/reports/daily'],
      ['post', '/api/inventory/receive'],
      ['get', '/api/integrity'],
      ['get', '/api/this-route-has-never-existed'],
    ];

    it.each(unconvertedRoutes)('%s %s answers 503 NOT_MIGRATED', async (method, path) => {
      const response = await request(createPostgresApp())[method as 'get' | 'post'](path).expect(503);
      expect(response.body.code).toBe('NOT_MIGRATED');
      expect(response.body.route).toBe(`${method.toUpperCase()} ${path}`);
      expect(response.body.error).toMatch(/not available yet/);
    });

    it('never answers a money route with an empty success', async () => {
      // A half-migrated server that returned [] for /api/sales would look healthy while hiding
      // every sale. 503 is the only acceptable answer until the slice is converted.
      const response = await request(createPostgresApp()).get('/api/sales');
      expect(response.status).not.toBe(200);
      expect(Array.isArray(response.body)).toBe(false);
    });
  });

  describe('startup validation', () => {
    it('refuses to build the PostgreSQL app while the engine is sqlite', () => {
      delete process.env.DATABASE_ENGINE;
      expect(() => createPostgresApp()).toThrow(/requires DATABASE_ENGINE=postgres/);
    });

    it('applies the same production/preview rules as the SQLite app', () => {
      expect(() => createPostgresApp({ production: true, preview: true })).toThrow(
        /PREVIEW_MODE must be disabled/,
      );
      expect(() => createPostgresApp({ production: true })).toThrow(/HTTPS APP_ORIGIN/);
      expect(() => createPostgresApp({ production: true, origin: 'http://pos.example.co.ke' })).toThrow(
        /HTTPS APP_ORIGIN/,
      );
      expect(() => createPostgresApp({ production: true, origin: 'https://pos.example.co.ke/pos' })).toThrow(
        /exact HTTPS origin/,
      );
    });
  });

  describe('connection failures are explained', () => {
    it('names the credential problem and where the secret belongs', async () => {
      const url = new URL(DATABASE_URL);
      url.password = 'definitely-the-wrong-password';
      await withDatabaseUrl(url.toString(), async () => {
        let message = '';
        try {
          await verifyConnection();
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toMatch(/rejected the credentials in DATABASE_URL/);
        expect(message).toMatch(/server environment only/);
        expect(message).not.toMatch(/definitely-the-wrong-password/); // never echo the secret back
      });
    });

    it('refuses to start the server when the credentials are wrong', async () => {
      const url = new URL(DATABASE_URL);
      url.password = 'definitely-the-wrong-password';
      await withDatabaseUrl(url.toString(), async () => {
        await expect(startPostgresServer({ port: 0, installSignalHandlers: false })).rejects.toThrow(
          /rejected the credentials/,
        );
      });
    });

    it('maps driver error codes to operator actions', () => {
      expect(explainConnectionFailure({ code: '28P01', message: 'password authentication failed' })).toMatch(
        /rejected the credentials/,
      );
      expect(
        explainConnectionFailure({ code: '3D000', message: 'database "kilele" does not exist' }),
      ).toMatch(/does not exist/);
      expect(explainConnectionFailure({ code: 'ENOTFOUND', message: 'getaddrinfo failed' })).toMatch(
        /resolve the database host/,
      );
      expect(explainConnectionFailure({ code: 'ECONNREFUSED', message: 'connection refused' })).toMatch(
        /allow-listed/,
      );
      expect(explainConnectionFailure({ code: 'ETIMEDOUT', message: 'timeout' })).toMatch(/timed out/);
      expect(
        explainConnectionFailure({
          code: '28000',
          message:
            'no pg_hba.conf entry for host "20.30.40.50", user "postgres", database "postgres", no encryption',
        }),
      ).toMatch(/DATABASE_SSL=require/);
      // A wrong password must not be dressed up as a TLS problem, or the operator fixes the wrong thing.
      expect(
        explainConnectionFailure({
          code: '28P01',
          message: 'password authentication failed for user "postgres"',
        }),
      ).not.toMatch(/DATABASE_SSL/);
      expect(
        explainConnectionFailure({ code: '28000', message: 'role "postgres" is not permitted to log in' }),
      ).toMatch(/refused the role or database/);
      expect(explainConnectionFailure({ weird: 'shape' })).not.toMatch(/\[object Object\]/);
    });
  });

  describe('the server boots and shuts down cleanly', () => {
    it('serves health over real HTTP, then closes the pool', async () => {
      const filesBefore = sqliteFiles();
      // preview: true so startup creates its own throwaway owner; Slice 2 made an uninitialised
      // non-preview database a startup error, which is asserted in the Slice 2 suite.
      const running = await startPostgresServer({ port: 0, installSignalHandlers: false, preview: true });
      try {
        expect(running.port).toBeGreaterThan(0);
        expect(running.info.protections).toBeGreaterThanOrEqual(65);
        expect(running.info.database.length).toBeGreaterThan(0);
        const health = await request(running.url).get('/api/health').expect(200);
        expect(health.body.database).toBe('available');
        await request(running.url).get('/api/sales').expect(503);
        // The client is not served outside production, so the SPA shell is not exposed by accident.
        await request(running.url).get('/').expect(404);
      } finally {
        await running.close();
      }
      // After close() the listener is gone and the pool is ended; a new pool must be buildable.
      await expect(request(running.url).get('/api/health')).rejects.toThrow();
      const reopened = await startPostgresServer({ port: 0, installSignalHandlers: false, preview: true });
      await request(reopened.url).get('/api/health').expect(200);
      await reopened.close();
      // The boot above classified this database as a preview, and that provenance is durable:
      // reopening the same database in non-preview mode must be refused (Slice 2's environment
      // guard), so a scratch or preview database can never be promoted to live books by accident.
      await expect(
        startPostgresServer({ port: 0, installSignalHandlers: false, preview: false, production: false }),
      ).rejects.toThrow(/cannot be promoted to live books/);
      await closePool().catch(() => undefined);
      setPool(null);
      // PostgreSQL mode never touches a SQLite file.
      expect(sqliteFiles()).toEqual(filesBefore);
    }, 60_000);

    it('reports pending migrations instead of starting when auto-migrate is off', async () => {
      // The scratch schema is already migrated, so this proves the check itself: point at a schema
      // with nothing in it and require an explicit migration step.
      const emptySchema = `${SCHEMA}_empty`;
      await raw(`CREATE SCHEMA ${emptySchema}`);
      const saved = process.env.DATABASE_SEARCH_PATH;
      process.env.DATABASE_SEARCH_PATH = emptySchema;
      setPool(null);
      try {
        await expect(
          startPostgresServer({ port: 0, installSignalHandlers: false, autoMigrate: false, preview: true }),
        ).rejects.toThrow(new RegExp(`missing ${MIGRATIONS.length} migration\\(s\\)`));
        const running = await startPostgresServer({
          port: 0,
          installSignalHandlers: false,
          autoMigrate: true,
          preview: true,
        });
        expect(running.info.migrationsApplied).toEqual(MIGRATIONS);
        await running.close();
      } finally {
        process.env.DATABASE_SEARCH_PATH = saved;
        setPool(null);
        await raw(`DROP SCHEMA IF EXISTS ${emptySchema} CASCADE`).catch(() => undefined);
      }
    }, 60_000);
  });
});
