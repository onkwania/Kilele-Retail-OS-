import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import pg from 'pg';
import request from 'supertest';
import { randomBytes, scryptSync } from 'node:crypto';
import { installErrorHandling, installSecurityMiddleware } from '../server/app-shared.js';
import { protect } from '../server/auth-shared.js';
import { sha } from '../server/core.js';
import { closePool, setPool } from '../server/postgres/db.js';
import { migrate } from '../server/postgres/migrate.js';
import { createPostgresApp } from '../server/postgres/app.js';
import { installPostgresAuth } from '../server/postgres/auth.js';
import { createWorkspace, seedReferenceData } from '../server/postgres/bootstrap.js';
import { guardEnvironment } from '../server/postgres/environment.js';
import { ensureWorkspace, startPostgresServer } from '../server/postgres/server.js';
import { exec, insert, one } from '../server/postgres/query.js';
import { transaction } from '../server/postgres/transaction.js';
import { verifyAudit } from '../server/postgres/check.js';
import { convertedSlices } from '../server/postgres/slices.js';

/**
 * Slice 2 of the PostgreSQL migration: bootstrap, authentication, sessions, CSRF, lockout and the
 * audit chain.
 *
 * Every acceptance requirement for the slice is asserted here against a real PostgreSQL server,
 * not a mock:
 *
 *   Bootstrap   - a clean database creates the first owner; bootstrap is one-time only; a second
 *                 run (and two simultaneous runs) cannot create another owner or business; the
 *                 business and branch are created correctly; operational provenance is recorded;
 *                 a preview database cannot be promoted; credentials are never logged.
 *   Auth        - the owner can sign in; wrong credentials fail safely without enumerating users;
 *                 an outage is distinguishable from bad credentials; hashing stays scrypt-based and
 *                 a legacy hash is upgraded in place; rotation works; a temporary password blocks
 *                 everything until it is changed; deactivated users cannot sign in.
 *   Sessions    - only the hash of the token is stored; expiry ends access; logout revokes; a
 *                 password change revokes every session; CSRF, Origin and Sec-Fetch-Site are
 *                 enforced; lockout and rate limits work; concurrent requests cannot corrupt
 *                 session or lockout state.
 *   Audit       - login, failure, logout, rotation and bootstrap are all recorded; the hash chain
 *                 verifies; audit rows live in the same transaction as the operation, so a rolled
 *                 back operation leaves no fragment behind.
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim() ?? '';
const REQUIRED = process.env.REQUIRE_POSTGRES_TESTS === '1';

if (!DATABASE_URL && REQUIRED) {
  throw new Error('REQUIRE_POSTGRES_TESTS=1 but DATABASE_URL is not set; Slice 2 would not be verified.');
}
if (!DATABASE_URL) {
  console.warn(
    '[postgres-slice2-auth] SKIPPED - DATABASE_URL is not set, so PostgreSQL authentication was NOT verified.',
  );
}

const describePg = DATABASE_URL ? describe : describe.skip;
const SCHEMA = `kilele_pg_auth_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

const OWNER = {
  name: 'Amina Owner',
  email: 'owner@kilele.test',
  password: 'correct-horse-battery-9',
  business: 'Amina Bottle Store',
};

async function raw(sql: string) {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

/**
 * Empties every business-scoped table plus the two global auth tables, between tests.
 *
 * The schema is named explicitly: this helper runs on its own connection, which does not carry the
 * pool's pinned `search_path`, so an unqualified TRUNCATE would empty the wrong schema.
 */
async function reset() {
  await raw(`TRUNCATE ${SCHEMA}.businesses CASCADE`);
  await raw(`TRUNCATE ${SCHEMA}.login_attempts, ${SCHEMA}.environment_markers`);
}

/**
 * Runs `body` with the immutability triggers on one table disabled. Used only to prove the audit
 * chain detects tampering - the triggers themselves are what stop tampering in production, and a
 * plain UPDATE is refused (that refusal is asserted elsewhere in the suite).
 */
async function withoutTriggers(table: string, body: () => Promise<void>) {
  await exec(await poolExecutor(), `ALTER TABLE ${table} DISABLE TRIGGER USER`);
  try {
    await body();
  } finally {
    await exec(await poolExecutor(), `ALTER TABLE ${table} ENABLE TRIGGER USER`);
  }
}

async function bootstrapOwner(overrides: Partial<typeof OWNER> = {}) {
  const details = { ...OWNER, ...overrides };
  const actor = await createWorkspace(details);
  return { details, actor };
}

/** The production surface: health, engine, auth, and 503 for everything unconverted. */
function apiApp(options: Parameters<typeof createPostgresApp>[0] = {}) {
  return createPostgresApp({ preview: false, production: false, ...options });
}

/**
 * A harness app carrying the real auth middleware plus two protected probe routes, so `protect()`
 * and the CSRF gate can be exercised before the business slices exist. The production surface
 * answers 503 NOT_MIGRATED for those paths instead.
 */
function authApp(options: { preview?: boolean; production?: boolean; origin?: string } = {}) {
  const resolved = { preview: false, production: false, ...options };
  const app = express();
  installSecurityMiddleware(app, resolved);
  installPostgresAuth(app, resolved);
  app.get('/api/__probe', protect(), (_req, res) => res.json({ ok: true }));
  app.get('/api/__reports', protect('reports.read'), (_req, res) => res.json({ ok: true }));
  installErrorHandling(app);
  return app;
}

function cookieOf(response: { headers: Record<string, unknown> }): string {
  const header = response.headers['set-cookie'];
  const first = Array.isArray(header) ? header[0] : header;
  return String(first ?? '').split(';')[0];
}

/** Returns the supertest Test (thenable), so callers can chain `.expect()` before awaiting. */
function login(app: unknown, email: string, password: string, headers: Record<string, string> = {}) {
  return request(app as express.Express)
    .post('/api/auth/login')
    .set(headers)
    .send({ email, password });
}

async function count(table: string): Promise<number> {
  const row = await one<{ total: number }>(
    await poolExecutor(),
    `SELECT COUNT(*)::int AS total FROM ${table}`,
  );
  return row?.total ?? 0;
}

async function poolExecutor() {
  const { getPool } = await import('../server/postgres/db.js');
  return getPool();
}

/** A legacy `salt:key` hash, exactly the form server/auth.ts still accepts and upgrades. */
function legacyHash(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `${salt}:${key}`;
}

describePg('Slice 2 - PostgreSQL bootstrap, authentication, sessions and audit', () => {
  beforeAll(async () => {
    await raw(`CREATE SCHEMA ${SCHEMA}`);
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.DATABASE_ENGINE = 'postgres';
    process.env.DATABASE_SEARCH_PATH = SCHEMA;
    setPool(null);
    await migrate();
    await transaction((tx) => seedReferenceData(tx));
  }, 180_000);

  afterAll(async () => {
    await closePool().catch(() => undefined);
    if (DATABASE_URL) await raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    delete process.env.DATABASE_SEARCH_PATH;
    delete process.env.DATABASE_ENGINE;
  });

  beforeEach(async () => {
    process.env.DATABASE_ENGINE = 'postgres';
    await reset();
  });

  describe('bootstrap', () => {
    it('creates the first owner, business and branch on a clean database', async () => {
      const { details, actor } = await bootstrapOwner();
      expect(actor.role_id).toBe('super_admin');
      expect(actor.business_id).toMatch(/^biz_/);
      expect(actor.branch_id).toMatch(/^br_/);

      const business = await one<{ name: string }>(
        await poolExecutor(),
        'SELECT name FROM businesses WHERE id = ?',
        actor.business_id,
      );
      expect(business?.name).toBe(details.business);
      const branch = await one<{ name: string; location: string; business_id: string }>(
        await poolExecutor(),
        'SELECT name, location, business_id FROM branches WHERE id = ?',
        actor.branch_id,
      );
      expect(branch).toEqual({ name: 'Main branch', location: '', business_id: actor.business_id });
      const user = await one<{ email: string; active: number; must_change_password: number }>(
        await poolExecutor(),
        'SELECT email, active, must_change_password FROM users WHERE id = ?',
        actor.id,
      );
      expect(user).toEqual({ email: details.email, active: 1, must_change_password: 0 });
    });

    it('records the workspace.created audit entry inside the same transaction', async () => {
      const { actor } = await bootstrapOwner();
      const entry = await one<{
        action: string;
        entity: string;
        entity_id: string;
        reason: string;
        after_json: string;
      }>(
        await poolExecutor(),
        "SELECT action, entity, entity_id, reason, after_json FROM audit_logs WHERE action = 'workspace.created'",
      );
      expect(entry).toMatchObject({
        entity: 'businesses',
        entity_id: actor.business_id,
        reason: 'Initial owner bootstrap',
      });
      expect(JSON.parse(entry!.after_json)).toEqual({ name: OWNER.business });
      expect(await verifyAudit()).toEqual([]);
    });

    it('is one-time only: a second bootstrap cannot create another owner or business', async () => {
      await bootstrapOwner();
      await expect(createWorkspace({ ...OWNER, email: 'second@kilele.test' })).rejects.toThrow(
        /already initialised\. Bootstrap is one-time only\./,
      );
      expect(await count('users')).toBe(1);
      expect(await count('businesses')).toBe(1);
      expect(await count('branches')).toBe(1);
    });

    it('serialises simultaneous bootstraps so exactly one workspace exists', async () => {
      const attempts = await Promise.allSettled(
        [1, 2, 3].map((n) => createWorkspace({ ...OWNER, email: `race${n}@kilele.test` })),
      );
      expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
      expect(await count('businesses')).toBe(1);
      expect(await count('users')).toBe(1);
      const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
      for (const failure of rejected)
        expect((failure as PromiseRejectedResult).reason.message).toMatch(/already initialised/);
    });

    it('records operational provenance in production and refuses to promote a preview database', async () => {
      const preview = await guardEnvironment({ preview: true, production: false });
      expect(preview.markerWritten).toBe('preview');
      expect(await count('environment_markers')).toBe(1);

      await expect(guardEnvironment({ preview: false, production: true })).rejects.toThrow(
        /cannot be promoted to live books/,
      );
      // Not just an explicit production flag: any non-preview use of a preview database is refused.
      await expect(guardEnvironment({ preview: false, production: false })).rejects.toThrow(
        /preview provenance/,
      );
      expect(
        await one(await poolExecutor(), "SELECT kind FROM environment_markers WHERE kind = 'operational'"),
      ).toBeNull();
    });

    it('refuses preview authentication on an operational database', async () => {
      const operational = await guardEnvironment({ preview: false, production: true });
      expect(operational.markerWritten).toBe('operational');
      await expect(guardEnvironment({ preview: true, production: false })).rejects.toThrow(
        /Refusing preview authentication on an operational or unclassified populated database/,
      );
    });

    it('refuses preview mode and production mode at the same time', async () => {
      await expect(guardEnvironment({ preview: true, production: true })).rejects.toThrow(
        /Preview mode is prohibited in production\./,
      );
    });

    it('treats a legacy preview identity as preview provenance', async () => {
      // A database that predates environment_markers is still recognised, by its audit history or
      // by the preview identity it was seeded with. Email addresses can only refuse a promotion -
      // they can never grant preview access.
      const { actor } = await bootstrapOwner({ email: 'legacy@preview.kilele.local' });
      expect(actor.email).toBe('legacy@preview.kilele.local');
      await expect(guardEnvironment({ preview: false, production: true })).rejects.toThrow(
        /preview provenance/,
      );
      // Case differences must not smuggle a promotion past the check.
      await exec(
        await poolExecutor(),
        "UPDATE users SET email = 'LEGACY@Preview.Kilele.Local' WHERE id = ?",
        actor.id,
      );
      await expect(guardEnvironment({ preview: false, production: true })).rejects.toThrow(
        /preview provenance/,
      );
    });

    it('never logs a bootstrap credential', async () => {
      const password = 'supplied-once-and-never-printed';
      process.env.BOOTSTRAP_NAME = 'Owner Name';
      process.env.BOOTSTRAP_EMAIL = 'operator@kilele.test';
      process.env.BOOTSTRAP_PASSWORD = password;
      process.env.BUSINESS_NAME = 'Operator Business';
      const logged: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      });
      try {
        expect(await ensureWorkspace({ preview: false })).toBe('created');
      } finally {
        spy.mockRestore();
        delete process.env.BOOTSTRAP_NAME;
        delete process.env.BOOTSTRAP_EMAIL;
        delete process.env.BOOTSTRAP_PASSWORD;
        delete process.env.BUSINESS_NAME;
      }
      const output = logged.join('\n');
      // The email is logged on purpose, so the operator knows which account was created, and the
      // variable *names* appear only as the instruction to remove them. The secret itself must not.
      expect(output).toContain('operator@kilele.test');
      expect(output).toContain('Remove BOOTSTRAP_NAME, BOOTSTRAP_EMAIL, and BOOTSTRAP_PASSWORD.');
      expect(output).not.toContain(password);
      expect(output).not.toContain(password.slice(0, 8));
      // The stored form is a scrypt hash, not the passphrase.
      const stored = await one<{ password_hash: string }>(
        await poolExecutor(),
        "SELECT password_hash FROM users WHERE email = 'operator@kilele.test'",
      );
      expect(stored?.password_hash).toMatch(/^scrypt-v2:[a-f0-9]{32}:[a-f0-9]{128}$/);
      expect(stored?.password_hash).not.toContain(password);
    });

    it('refuses to start an uninitialised server without bootstrap credentials', async () => {
      await expect(
        startPostgresServer({ port: 0, installSignalHandlers: false, preview: false, production: false }),
      ).rejects.toThrow(/Production database is uninitialised/);
      await closePool().catch(() => undefined);
      setPool(null);
    });

    it('boots a preview server that creates its own throwaway owner and can sign in', async () => {
      const running = await startPostgresServer({
        port: 0,
        installSignalHandlers: false,
        preview: true,
        production: false,
      });
      try {
        expect(running.info.workspace).toBe('created');
        expect(running.info.environment.markerWritten).toBe('preview');
        expect(running.info.protections).toBeGreaterThanOrEqual(65);
        expect(convertedSlices()).toEqual(expect.arrayContaining(['health', 'bootstrap', 'auth']));

        const health = await request(running.url).get('/api/health').expect(200);
        expect(health.body).toEqual({
          status: 'ok',
          currency: 'KES',
          database: 'available',
          engine: 'postgres',
        });

        const engine = await request(running.url).get('/api/engine').expect(200);
        expect(engine.body.migrated).toEqual(expect.arrayContaining(['bootstrap', 'auth']));
        expect(engine.body.pending.map((entry: { slice: string }) => entry.slice)).toContain('sales');

        // Money routes stay fail-closed even though authentication now works.
        const sales = await request(running.url).get('/api/sales').expect(503);
        expect(sales.body.code).toBe('NOT_MIGRATED');

        const preview = await request(running.url).post('/api/auth/preview').expect(200);
        expect(preview.body.user.role_id).toBe('super_admin');
        expect(preview.body.user.email).toBe('owner@preview.kilele.local');
        expect(cookieOf(preview)).toMatch(/^kilele_session=/);
        expect(preview.body.csrf).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        await running.close();
      }
    });
  });

  describe('authentication', () => {
    it('signs the owner in and returns a session cookie plus a CSRF token', async () => {
      await bootstrapOwner();
      const app = authApp();
      const response = await login(app, OWNER.email, OWNER.password).expect(200);
      expect(response.body.user.email).toBe(OWNER.email);
      expect(response.body.csrf).toMatch(/^[a-f0-9]{64}$/);
      expect(cookieOf(response)).toMatch(/^kilele_session=[a-f0-9]{64}$/);
      expect(response.headers['set-cookie'][0]).toContain('HttpOnly');
      expect(response.headers['set-cookie'][0]).toContain('SameSite=Strict');

      const me = await request(app).get('/api/auth/me').set('Cookie', cookieOf(response)).expect(200);
      expect(me.body.user.email).toBe(OWNER.email);
      expect(me.body.business.name).toBe(OWNER.business);
      expect(me.body.branch.name).toBe('Main branch');
      expect(me.body.preview).toBe(false);
    });

    it('accepts the address in any case, because emails are matched case-insensitively', async () => {
      await bootstrapOwner();
      const response = await login(authApp(), '  Owner@Kilele.TEST '.trim().toUpperCase(), OWNER.password);
      expect(response.status).toBe(200);
    });

    it('fails a wrong password safely: 401, no cookie, and a recorded failure', async () => {
      const { actor } = await bootstrapOwner();
      const app = authApp();
      const response = await login(app, OWNER.email, 'not-the-password').expect(401);
      expect(response.body).toEqual({ error: 'Email or password is incorrect.', code: 'VALIDATION_ERROR' });
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(await count('auth_sessions')).toBe(0);

      const attempt = await one<{ email: string; failures: number; locked_until: string | null }>(
        await poolExecutor(),
        'SELECT email, failures, locked_until FROM login_attempts WHERE email = ?',
        OWNER.email,
      );
      expect(attempt).toEqual({ email: OWNER.email, failures: 1, locked_until: null });

      const failure = await one<{ action: string; entity_id: string; reason: string }>(
        await poolExecutor(),
        "SELECT action, entity_id, reason FROM audit_logs WHERE action = 'auth.login_failed'",
      );
      expect(failure).toEqual({
        action: 'auth.login_failed',
        entity_id: actor.id,
        reason: 'Invalid credentials',
      });
    });

    it('gives an unknown address the same answer as a wrong password', async () => {
      await bootstrapOwner();
      const known = await login(authApp(), OWNER.email, 'wrong-password');
      const unknown = await login(authApp(), 'nobody@kilele.test', 'wrong-password');
      expect(unknown.status).toBe(401);
      expect(unknown.body).toEqual(known.body);
      expect(unknown.headers['set-cookie']).toBeUndefined();
    });

    it('refuses a deactivated user even with the correct password', async () => {
      const { actor } = await bootstrapOwner();
      await exec(await poolExecutor(), 'UPDATE users SET active = 0 WHERE id = ?', actor.id);
      const response = await login(authApp(), OWNER.email, OWNER.password).expect(401);
      expect(response.body.error).toBe('Email or password is incorrect.');
      expect(await count('auth_sessions')).toBe(0);
      // An existing session dies with the account: the actor lookup requires active = 1.
      await exec(await poolExecutor(), 'UPDATE users SET active = 1 WHERE id = ?', actor.id);
      const signedIn = await login(authApp(), OWNER.email, OWNER.password).expect(200);
      await exec(await poolExecutor(), 'UPDATE users SET active = 0 WHERE id = ?', actor.id);
      await request(authApp()).get('/api/__probe').set('Cookie', cookieOf(signedIn)).expect(401);
    });

    it('keeps password hashing on scrypt and upgrades a legacy hash after a successful sign-in', async () => {
      const { actor } = await bootstrapOwner();
      const stored = await one<{ password_hash: string }>(
        await poolExecutor(),
        'SELECT password_hash FROM users WHERE id = ?',
        actor.id,
      );
      expect(stored?.password_hash).toMatch(/^scrypt-v2:[a-f0-9]{32}:[a-f0-9]{128}$/);

      await exec(
        await poolExecutor(),
        'UPDATE users SET password_hash = ? WHERE id = ?',
        legacyHash(OWNER.password),
        actor.id,
      );
      const response = await login(authApp(), OWNER.email, OWNER.password).expect(200);
      expect(cookieOf(response)).toMatch(/^kilele_session=/);
      const upgraded = await one<{ password_hash: string }>(
        await poolExecutor(),
        'SELECT password_hash FROM users WHERE id = ?',
        actor.id,
      );
      expect(upgraded?.password_hash).toMatch(/^scrypt-v2:/);
      const rehash = await one<{ action: string; after_json: string }>(
        await poolExecutor(),
        "SELECT action, after_json FROM audit_logs WHERE action = 'auth.password_rehashed'",
      );
      expect(rehash?.after_json).toBe(JSON.stringify({ scheme: 'scrypt-v2' }));
    });

    it('rotates a password, requires the current one, and refuses to reuse it', async () => {
      await bootstrapOwner();
      const app = authApp();
      const signedIn = await login(app, OWNER.email, OWNER.password).expect(200);
      const cookie = cookieOf(signedIn);
      const csrf = signedIn.body.csrf;

      await request(app)
        .post('/api/auth/password')
        .set('Cookie', cookie)
        .set('x-csrf-token', csrf)
        .send({ current: 'wrong-current-password', password: 'a-completely-new-passphrase' })
        .expect(400);
      await request(app)
        .post('/api/auth/password')
        .set('Cookie', cookie)
        .set('x-csrf-token', csrf)
        .send({ current: OWNER.password, password: OWNER.password })
        .expect(400);

      const rotated = await request(app)
        .post('/api/auth/password')
        .set('Cookie', cookie)
        .set('x-csrf-token', csrf)
        .send({ current: OWNER.password, password: 'a-completely-new-passphrase' })
        .expect(200);
      expect(rotated.body.csrf).toMatch(/^[a-f0-9]{64}$/);
      expect(cookieOf(rotated)).not.toBe(cookie);

      await login(app, OWNER.email, OWNER.password).expect(401);
      await login(app, OWNER.email, 'a-completely-new-passphrase').expect(200);
      const entry = await one<{ after_json: string }>(
        await poolExecutor(),
        "SELECT after_json FROM audit_logs WHERE action = 'auth.password_changed'",
      );
      expect(entry?.after_json).toBe(JSON.stringify({ sessions_revoked: true }));
    });

    it('blocks every protected route until a temporary password is changed', async () => {
      const { actor } = await bootstrapOwner();
      await exec(await poolExecutor(), 'UPDATE users SET must_change_password = 1 WHERE id = ?', actor.id);
      const app = authApp();
      const signedIn = await login(app, OWNER.email, OWNER.password).expect(200);
      const cookie = cookieOf(signedIn);

      const blocked = await request(app).get('/api/__probe').set('Cookie', cookie).expect(403);
      expect(blocked.body).toEqual({
        error: 'Change your temporary password before continuing.',
        code: 'PASSWORD_CHANGE_REQUIRED',
      });

      const changed = await request(app)
        .post('/api/auth/password')
        .set('Cookie', cookie)
        .set('x-csrf-token', signedIn.body.csrf)
        .send({ current: OWNER.password, password: 'replaced-temporary-passphrase' })
        .expect(200);
      await request(app).get('/api/__probe').set('Cookie', cookieOf(changed)).expect(200);
      const cleared = await one<{ must_change_password: number }>(
        await poolExecutor(),
        'SELECT must_change_password FROM users WHERE id = ?',
        actor.id,
      );
      expect(cleared?.must_change_password).toBe(0);
    });

    it('requires a signed-in actor, and the permission the route demands', async () => {
      await bootstrapOwner();
      const app = authApp();
      const anonymous = await request(app).get('/api/__probe').expect(401);
      expect(anonymous.body.code).toBe('UNAUTHENTICATED');

      const signedIn = await login(app, OWNER.email, OWNER.password).expect(200);
      await request(app).get('/api/__reports').set('Cookie', cookieOf(signedIn)).expect(200);

      // A cashier has no reports permission: the same route must refuse them.
      await transaction(async (tx) => {
        const owner = await one<{ business_id: string; branch_id: string }>(
          tx,
          'SELECT business_id, branch_id FROM users LIMIT 1',
        );
        await insert(tx, 'users', {
          id: 'usr_cashier_probe',
          business_id: owner!.business_id,
          branch_id: owner!.branch_id,
          role_id: 'cashier',
          name: 'Cashier Probe',
          email: 'cashier@kilele.test',
          password_hash: legacyHash('cashier-passphrase-1'),
          created_at: new Date().toISOString(),
        });
      });
      const cashierLogin = await login(app, 'cashier@kilele.test', 'cashier-passphrase-1').expect(200);
      await request(app).get('/api/__probe').set('Cookie', cookieOf(cashierLogin)).expect(200);
      const refused = await request(app)
        .get('/api/__reports')
        .set('Cookie', cookieOf(cashierLogin))
        .expect(403);
      expect(refused.body.error).toMatch(/permission|not allowed|forbidden/i);
    });

    it('reports an unreachable database as 503, never as invalid credentials', async () => {
      await bootstrapOwner();
      const deadUrl = 'postgresql://kilele:kilele@127.0.0.1:1/kilele';
      const savedUrl = process.env.DATABASE_URL;
      process.env.DATABASE_URL = deadUrl;
      setPool(null);
      try {
        const response = await login(authApp(), OWNER.email, OWNER.password).expect(503);
        expect(response.body.code).toBe('DATABASE_UNAVAILABLE');
        expect(response.body.error).toMatch(/database is unavailable/i);
        expect(JSON.stringify(response.body)).not.toMatch(/incorrect/);
      } finally {
        process.env.DATABASE_URL = savedUrl;
        await closePool().catch(() => undefined);
        setPool(null);
      }
      // And the connection recovers: the same request now answers 401/200, not 503.
      await login(authApp(), OWNER.email, 'wrong-password').expect(401);
    });

    it('publishes the login and password rate limits it enforces', async () => {
      await bootstrapOwner();
      const app = authApp();
      const loginResponse = await login(app, OWNER.email, 'wrong-password');
      expect(loginResponse.headers['ratelimit-policy']).toContain('20');
      const signedIn = await login(app, OWNER.email, OWNER.password).expect(200);
      const passwordResponse = await request(app)
        .post('/api/auth/password')
        .set('Cookie', cookieOf(signedIn))
        .set('x-csrf-token', signedIn.body.csrf)
        .send({ current: OWNER.password, password: OWNER.password });
      expect(passwordResponse.headers['ratelimit-policy']).toContain('10');
    });
  });

  describe('sessions, CSRF and lockout', () => {
    it('stores only the hash of the session token', async () => {
      await bootstrapOwner();
      const response = await login(authApp(), OWNER.email, OWNER.password).expect(200);
      const token = cookieOf(response).replace('kilele_session=', '');
      const row = await one<{ token_hash: string; csrf_token: string; user_agent: string; ip: string }>(
        await poolExecutor(),
        'SELECT token_hash, csrf_token, user_agent, ip FROM auth_sessions',
      );
      expect(row?.token_hash).toBe(sha(token));
      expect(row?.token_hash).not.toBe(token);
      expect(row?.csrf_token).toBe(response.body.csrf);
      expect(row?.csrf_token).not.toBe(token);
      // The raw token appears nowhere in the row, and the audit chain never sees it either.
      const auditText = await one<{ everything: string }>(
        await poolExecutor(),
        "SELECT string_agg(before_json || after_json || reason || device, ' ') AS everything FROM audit_logs",
      );
      expect(auditText?.everything ?? '').not.toContain(token);
      expect(row?.user_agent.length).toBeLessThanOrEqual(300);
      expect(typeof row?.ip).toBe('string');
    });

    it('ends access when the session expires', async () => {
      await bootstrapOwner();
      const app = authApp();
      const signedIn = await login(app, OWNER.email, OWNER.password).expect(200);
      const cookie = cookieOf(signedIn);
      await request(app).get('/api/__probe').set('Cookie', cookie).expect(200);
      await exec(await poolExecutor(), "UPDATE auth_sessions SET expires_at = '2000-01-01T00:00:00.000Z'");
      await request(app).get('/api/__probe').set('Cookie', cookie).expect(401);
      await request(app)
        .get('/api/auth/me')
        .set('Cookie', cookie)
        .expect(200)
        .expect({ user: null, csrf: null, preview: false, business: null, branch: null });
      // A forged token is worthless: only the stored hash is ever compared.
      await request(app)
        .get('/api/__probe')
        .set('Cookie', `kilele_session=${sha('forged')}`)
        .expect(401);
    });

    it('revokes the session on logout and records it', async () => {
      await bootstrapOwner();
      const app = authApp();
      const signedIn = await login(app, OWNER.email, OWNER.password).expect(200);
      const cookie = cookieOf(signedIn);
      expect(await count('auth_sessions')).toBe(1);

      const logout = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', cookie)
        .set('x-csrf-token', signedIn.body.csrf)
        .expect(200);
      expect(logout.body).toEqual({ ok: true });
      expect(logout.headers['set-cookie'][0]).toMatch(/kilele_session=;/);
      expect(await count('auth_sessions')).toBe(0);
      await request(app).get('/api/__probe').set('Cookie', cookie).expect(401);
      const entry = await one<{ action: string; reason: string }>(
        await poolExecutor(),
        "SELECT action, reason FROM audit_logs WHERE action = 'auth.logout'",
      );
      expect(entry).toEqual({ action: 'auth.logout', reason: 'User signed out' });
    });

    it('revokes every other session when the password changes', async () => {
      await bootstrapOwner();
      const app = authApp();
      const first = await login(app, OWNER.email, OWNER.password).expect(200);
      const second = await login(app, OWNER.email, OWNER.password).expect(200);
      expect(await count('auth_sessions')).toBe(2);

      const rotated = await request(app)
        .post('/api/auth/password')
        .set('Cookie', cookieOf(first))
        .set('x-csrf-token', first.body.csrf)
        .send({ current: OWNER.password, password: 'rotated-and-every-session-dies' })
        .expect(200);

      // The second device is signed out; the device that rotated the password gets a new session.
      expect(await count('auth_sessions')).toBe(1);
      await request(app).get('/api/__probe').set('Cookie', cookieOf(second)).expect(401);
      await request(app).get('/api/__probe').set('Cookie', cookieOf(rotated)).expect(200);
    });

    it('requires the CSRF token for state-changing requests and exempts reads', async () => {
      await bootstrapOwner();
      const app = authApp();
      const signedIn = await login(app, OWNER.email, OWNER.password).expect(200);
      const cookie = cookieOf(signedIn);

      const missing = await request(app).post('/api/auth/logout').set('Cookie', cookie).expect(403);
      expect(missing.body).toEqual({
        error: 'Security token is missing or expired. Refresh and try again.',
        code: 'CSRF_REJECTED',
      });
      const wrong = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', cookie)
        .set('x-csrf-token', 'f'.repeat(64))
        .expect(403);
      expect(wrong.body.code).toBe('CSRF_REJECTED');
      expect(await count('auth_sessions')).toBe(1);

      // Reads are exempt, and so is the sign-in that establishes the session.
      await request(app).get('/api/auth/me').set('Cookie', cookie).expect(200);
      await request(app)
        .post('/api/auth/logout')
        .set('Cookie', cookie)
        .set('x-csrf-token', signedIn.body.csrf)
        .expect(200);
    });

    it('validates the Origin header against the configured app origin', async () => {
      await bootstrapOwner();
      const app = authApp({ production: true, origin: 'https://pos.example.co.ke' });
      const signedIn = await login(app, OWNER.email, OWNER.password).expect(200);
      const cookie = cookieOf(signedIn);

      const foreign = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', cookie)
        .set('x-csrf-token', signedIn.body.csrf)
        .set('Origin', 'https://evil.example')
        .expect(403);
      expect(foreign.body).toEqual({ error: 'Request origin is not allowed.', code: 'CSRF_REJECTED' });

      const allowed = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', cookie)
        .set('x-csrf-token', signedIn.body.csrf)
        .set('Origin', 'https://pos.example.co.ke')
        .expect(200);
      expect(allowed.body).toEqual({ ok: true });
    });

    it('blocks cross-site requests even with a valid CSRF token', async () => {
      await bootstrapOwner();
      const app = authApp();
      const signedIn = await login(app, OWNER.email, OWNER.password).expect(200);
      const response = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', cookieOf(signedIn))
        .set('x-csrf-token', signedIn.body.csrf)
        .set('Sec-Fetch-Site', 'cross-site')
        .expect(403);
      expect(response.body.error).toBe('Cross-site request blocked.');
      expect(await count('auth_sessions')).toBe(1);
    });

    it('locks the address after five failures, and a correct password cannot bypass the lock', async () => {
      await bootstrapOwner();
      const app = authApp();
      for (let attempt = 1; attempt <= 4; attempt++) {
        const response = await login(app, OWNER.email, 'wrong-password');
        expect(response.status).toBe(401);
        const row = await one<{ failures: number; locked_until: string | null }>(
          await poolExecutor(),
          'SELECT failures, locked_until FROM login_attempts WHERE email = ?',
          OWNER.email,
        );
        expect(row?.failures).toBe(attempt);
        expect(row?.locked_until).toBeNull();
      }
      const fifth = await login(app, OWNER.email, 'wrong-password').expect(401);
      expect(fifth.status).toBe(401);
      const locked = await one<{ failures: number; locked_until: string | null }>(
        await poolExecutor(),
        'SELECT failures, locked_until FROM login_attempts WHERE email = ?',
        OWNER.email,
      );
      expect(locked?.failures).toBe(5);
      expect(locked?.locked_until).not.toBeNull();
      expect(Date.parse(locked!.locked_until!) - Date.now()).toBeGreaterThan(14 * 60_000);

      const blocked = await login(app, OWNER.email, OWNER.password).expect(429);
      expect(blocked.body.error).toBe('Sign-in is temporarily locked. Try again in 15 minutes.');
      expect(await count('auth_sessions')).toBe(0);
    });

    it('counts concurrent failed logins without losing an attempt', async () => {
      await bootstrapOwner();
      const app = authApp();
      const responses = await Promise.all([1, 2, 3, 4].map(() => login(app, OWNER.email, 'wrong-password')));
      expect(responses.every((response) => response.status === 401)).toBe(true);
      const row = await one<{ failures: number }>(
        await poolExecutor(),
        'SELECT failures FROM login_attempts WHERE email = ?',
        OWNER.email,
      );
      // A read-modify-write counter would store 1 here; the SQL increment stores 4.
      expect(row?.failures).toBe(4);
    });

    it('keeps simultaneous sign-ins and requests from corrupting session state', async () => {
      await bootstrapOwner();
      const app = authApp();
      const logins = await Promise.all([1, 2, 3, 4, 5, 6].map(() => login(app, OWNER.email, OWNER.password)));
      expect(logins.every((response) => response.status === 200)).toBe(true);
      const cookies = logins.map(cookieOf);
      expect(new Set(cookies).size).toBe(6);
      expect(await count('auth_sessions')).toBe(6);

      // Every one of those sessions is independently valid, and reading with all of them at once
      // neither invalidates nor duplicates anything.
      const probes = await Promise.all(
        cookies.map((cookie) => request(app).get('/api/__probe').set('Cookie', cookie)),
      );
      expect(probes.every((response) => response.status === 200)).toBe(true);
      expect(await count('auth_sessions')).toBe(6);
      const distinct = await one<{ distinct_hashes: number }>(
        await poolExecutor(),
        'SELECT COUNT(DISTINCT token_hash)::int AS distinct_hashes FROM auth_sessions',
      );
      expect(distinct?.distinct_hashes).toBe(6);
      expect(await verifyAudit()).toEqual([]);
    });
  });

  describe('the unconverted business surface stays closed', () => {
    it('authenticates, and still refuses every route outside a converted slice', async () => {
      await bootstrapOwner();
      const app = apiApp();
      const signedIn = await login(app, OWNER.email, OWNER.password).expect(200);
      const cookie = cookieOf(signedIn);

      // Being signed in must not open a money route that has not been converted: an authenticated
      // 200 with an empty list would be indistinguishable from "no sales today".
      for (const route of ['/api/sales', '/api/products', '/api/inventory', '/api/reports/daily']) {
        const response = await request(app).get(route).set('Cookie', cookie).expect(503);
        expect(response.body.code).toBe('NOT_MIGRATED');
        expect(response.body.route).toBe(`GET ${route}`);
        expect(response.body.migrated).toEqual(expect.arrayContaining(['health', 'bootstrap', 'auth']));
      }
      const health = await request(app).get('/api/health').expect(200);
      expect(health.body.database).toBe('available');
    });
  });

  describe('audit', () => {
    it('records the sign-in with actor, provenance and a linked hash chain', async () => {
      const { actor } = await bootstrapOwner();
      await login(authApp(), OWNER.email, OWNER.password, { 'User-Agent': 'KilelePOS/1.0 (tablet)' }).expect(
        200,
      );
      const entry = await one<{
        user_id: string;
        role: string;
        action: string;
        entity: string;
        entity_id: string;
        business_id: string;
        branch_id: string;
        previous_hash: string;
        device: string;
      }>(await poolExecutor(), "SELECT * FROM audit_logs WHERE action = 'auth.login'");
      expect(entry).toMatchObject({
        user_id: actor.id,
        role: 'super_admin',
        entity: 'users',
        entity_id: actor.id,
        business_id: actor.business_id,
        branch_id: actor.branch_id,
      });
      expect(entry?.previous_hash).not.toBe('GENESIS');
      expect(entry?.device).toBe('KilelePOS/1.0 (tablet)');
      expect(await verifyAudit()).toEqual([]);
    });

    it('keeps the chain verifiable across bootstrap, failure, sign-in, rotation and logout', async () => {
      const { actor } = await bootstrapOwner();
      const app = authApp();
      await login(app, OWNER.email, 'wrong-password').expect(401);
      const signedIn = await login(app, OWNER.email, OWNER.password).expect(200);
      await request(app)
        .post('/api/auth/password')
        .set('Cookie', cookieOf(signedIn))
        .set('x-csrf-token', signedIn.body.csrf)
        .send({ current: OWNER.password, password: 'chained-rotation-passphrase' })
        .expect(200);
      const actions = await one<{ actions: string }>(
        await poolExecutor(),
        "SELECT string_agg(action, ',' ORDER BY seq) AS actions FROM audit_logs",
      );
      expect(actions?.actions).toBe('workspace.created,auth.login_failed,auth.login,auth.password_changed');
      expect(await verifyAudit()).toEqual([]);
      // An ordinary rewrite is refused outright: audit rows are immutable.
      await expect(
        exec(
          await poolExecutor(),
          "UPDATE audit_logs SET reason = 'rewritten by an attacker' WHERE user_id = ? AND action = 'auth.login'",
          actor.id,
        ),
      ).rejects.toThrow(/audit_logs records are immutable/);
      // With the guard disabled - i.e. someone with superuser access - the chain still detects it.
      await withoutTriggers('audit_logs', async () => {
        await exec(
          await poolExecutor(),
          "UPDATE audit_logs SET reason = 'rewritten by an attacker' WHERE user_id = ? AND action = 'auth.login'",
          actor.id,
        );
      });
      const errors = await verifyAudit();
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toMatch(/^Audit chain mismatch at \d+$/);
    });

    it('writes audit rows inside the operation transaction, so a rollback leaves no fragment', async () => {
      const { actor } = await bootstrapOwner();
      const before = await count('audit_logs');
      await expect(
        transaction(async (tx) => {
          const { audit } = await import('../server/postgres/audit.js');
          await audit(tx, actor, 'probe.rolled_back', 'users', actor.id, null, null, 'must not survive');
          throw new Error('financial unit failed after the audit write');
        }),
      ).rejects.toThrow(/financial unit failed/);
      expect(await count('audit_logs')).toBe(before);
      expect(
        await one(await poolExecutor(), "SELECT id FROM audit_logs WHERE action = 'probe.rolled_back'"),
      ).toBeNull();
      // The chain is still intact: nothing partial was ever committed.
      expect(await verifyAudit()).toEqual([]);
    });

    it('refuses to write an audit row outside a transaction', async () => {
      const { actor } = await bootstrapOwner();
      const { audit } = await import('../server/postgres/audit.js');
      // A pooled connection is not a transaction; the writer must refuse it rather than extend
      // the chain without the lock that keeps it serialised.
      const pool = (await poolExecutor()) as unknown as Parameters<typeof audit>[0];
      await expect(
        audit(pool, actor, 'probe.detached', 'users', actor.id, null, null, 'no chain'),
      ).rejects.toThrow(/requires a transaction/);
      expect(await count('audit_logs')).toBe(1);
    });

    it('commits the failure bookkeeping even though the sign-in itself is refused', async () => {
      // The 401 is raised after COMMIT on purpose: the attempt counter, the lockout and the
      // auth.login_failed row must survive a refused sign-in, or brute force is free.
      const { actor } = await bootstrapOwner();
      await login(authApp(), OWNER.email, 'wrong-password').expect(401);
      expect(await count('login_attempts')).toBe(1);
      const failure = await one<{ entity_id: string }>(
        await poolExecutor(),
        "SELECT entity_id FROM audit_logs WHERE action = 'auth.login_failed'",
      );
      expect(failure?.entity_id).toBe(actor.id);
      expect(await count('auth_sessions')).toBe(0);
    });
  });
});
