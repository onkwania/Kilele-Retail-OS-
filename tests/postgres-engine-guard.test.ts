import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertEngineUsable,
  convertedSlices,
  engine,
  markSliceConverted,
  poolSettings,
} from '../server/postgres/db.js';
import { translate } from '../server/postgres/query.js';
import { createDb } from '../server/db.js';

/**
 * Engine-selection and SQL-dialect guards. These need no database, so they run in every CI job
 * and on every laptop: they are the tests that stop a deployment from claiming to be on
 * PostgreSQL while quietly serving the SQLite file, and from sending SQLite-only SQL to a
 * PostgreSQL server.
 *
 * The behavioural schema/trigger suite lives in tests/postgres-schema.test.ts and needs a real
 * server (DATABASE_URL).
 */

const ENV_KEYS = [
  'DATABASE_ENGINE',
  'DATABASE_URL',
  'DATABASE_POOL_MAX',
  'DATABASE_SSL',
  'DATABASE_SEARCH_PATH',
  'DATABASE_IDLE_TIMEOUT_MS',
  'DATABASE_CONNECTION_TIMEOUT_MS',
  'DATABASE_APPLICATION_NAME',
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('storage engine selection', () => {
  it('defaults to SQLite', () => {
    expect(engine()).toBe('sqlite');
    process.env.DATABASE_ENGINE = 'sqlite';
    expect(engine()).toBe('sqlite');
  });

  it('accepts postgres and postgresql', () => {
    process.env.DATABASE_ENGINE = 'postgres';
    expect(engine()).toBe('postgres');
    process.env.DATABASE_ENGINE = 'PostgreSQL';
    expect(engine()).toBe('postgres');
  });

  it('refuses an ambiguous engine rather than guessing', () => {
    process.env.DATABASE_ENGINE = 'mysql';
    expect(() => engine()).toThrow(/must be "sqlite" or "postgres"/);
  });

  it('is a no-op in SQLite mode', () => {
    expect(() => assertEngineUsable()).not.toThrow();
  });

  it('fails loudly in postgres mode without a connection string', () => {
    process.env.DATABASE_ENGINE = 'postgres';
    expect(() => assertEngineUsable()).toThrow(/requires DATABASE_URL/);
  });

  it('fails loudly in postgres mode until the module is converted', () => {
    process.env.DATABASE_ENGINE = 'postgres';
    process.env.DATABASE_URL = 'postgresql://user:pass@db.example.co.ke:5432/kilele';
    expect(() => assertEngineUsable('sales')).toThrow(/has not been converted/);
    expect(() => assertEngineUsable('sales')).toThrow(/refuses to start/);
  });

  it('permits a slice once it has been converted', () => {
    process.env.DATABASE_ENGINE = 'postgres';
    process.env.DATABASE_URL = 'postgresql://user:pass@db.example.co.ke:5432/kilele';
    expect(convertedSlices()).not.toContain('guard-test-slice');
    markSliceConverted('guard-test-slice');
    expect(() => assertEngineUsable('guard-test-slice')).not.toThrow();
    // An unconverted slice is still blocked.
    expect(() => assertEngineUsable('another-slice')).toThrow(/has not been converted/);
  });

  it('blocks the SQLite data layer itself, so no entrypoint can bypass the guard', () => {
    process.env.DATABASE_ENGINE = 'postgres';
    process.env.DATABASE_URL = 'postgresql://user:pass@db.example.co.ke:5432/kilele';
    // createDb is the single choke point used by the API, bootstrap, check, backup and restore.
    expect(() => createDb(':memory:')).toThrow(/refuses to start/);
  });
});

describe('connection settings', () => {
  const url = 'postgresql://user:pass@db.example.co.ke:5432/kilele';

  it('requires a connection string', () => {
    expect(() => poolSettings({} as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL is not set/);
  });

  it('refuses a SQLite path in a PostgreSQL variable', () => {
    expect(() => poolSettings({ DATABASE_URL: 'file:./data/kilele.sqlite' } as NodeJS.ProcessEnv)).toThrow(
      /points at a SQLite file/,
    );
  });

  it('validates the pool size', () => {
    expect(() => poolSettings({ DATABASE_URL: url, DATABASE_POOL_MAX: '0' } as NodeJS.ProcessEnv)).toThrow(
      /between 1 and 100/,
    );
    expect(poolSettings({ DATABASE_URL: url, DATABASE_POOL_MAX: '4' } as NodeJS.ProcessEnv).max).toBe(4);
    expect(poolSettings({ DATABASE_URL: url } as NodeJS.ProcessEnv).max).toBe(10);
  });

  it('maps DATABASE_SSL to a TLS mode', () => {
    expect(poolSettings({ DATABASE_URL: url } as NodeJS.ProcessEnv).ssl).toBeUndefined();
    expect(
      poolSettings({ DATABASE_URL: url, DATABASE_SSL: 'disable' } as NodeJS.ProcessEnv).ssl,
    ).toBeUndefined();
    // Supabase requires TLS but serves a managed certificate: accept it without local CA validation.
    expect(poolSettings({ DATABASE_URL: url, DATABASE_SSL: 'require' } as NodeJS.ProcessEnv).ssl).toEqual({
      rejectUnauthorized: false,
    });
    expect(poolSettings({ DATABASE_URL: url, DATABASE_SSL: 'verify-full' } as NodeJS.ProcessEnv).ssl).toEqual(
      {
        rejectUnauthorized: true,
      },
    );
  });

  it('pins search_path only for a valid identifier', () => {
    expect(poolSettings({ DATABASE_URL: url } as NodeJS.ProcessEnv).options).toBeUndefined();
    expect(
      poolSettings({ DATABASE_URL: url, DATABASE_SEARCH_PATH: 'staging' } as NodeJS.ProcessEnv).options,
    ).toBe('-csearch_path=staging');
    expect(() =>
      poolSettings({
        DATABASE_URL: url,
        DATABASE_SEARCH_PATH: 'public; DROP TABLE sales',
      } as NodeJS.ProcessEnv),
    ).toThrow(/single SQL identifier/);
  });
});

describe('SQL dialect guard', () => {
  it('rewrites ? placeholders to $n, ignoring literals, quoted identifiers and comments', () => {
    expect(translate('SELECT * FROM t WHERE a = ? AND b = ?')).toBe(
      'SELECT * FROM t WHERE a = $1 AND b = $2',
    );
    expect(translate("SELECT '?' AS q, a FROM t WHERE b = ?")).toBe("SELECT '?' AS q, a FROM t WHERE b = $1");
    expect(translate('SELECT "weird?col" FROM t WHERE b = ?')).toBe('SELECT "weird?col" FROM t WHERE b = $1');
    expect(translate('SELECT a FROM t -- where b = ?\nWHERE c = ?')).toBe(
      'SELECT a FROM t -- where b = ?\nWHERE c = $1',
    );
    expect(translate('SELECT a /* where b = ? */ FROM t WHERE c = ?')).toBe(
      'SELECT a /* where b = ? */ FROM t WHERE c = $1',
    );
    expect(translate("SELECT 'it''s ?' FROM t WHERE c = ?")).toBe("SELECT 'it''s ?' FROM t WHERE c = $1");
  });

  it('rejects upsert spellings that could replace a financial record', () => {
    expect(() => translate('INSERT OR REPLACE INTO sales (id) VALUES (?)')).toThrow(/INSERT OR REPLACE/);
    expect(() => translate('INSERT OR IGNORE INTO sales (id) VALUES (?)')).toThrow(/ON CONFLICT DO NOTHING/);
    expect(() => translate('INSERT OR ROLLBACK INTO sales (id) VALUES (?)')).toThrow(/ON CONFLICT/);
  });

  it('rejects SQLite-only syntax with an actionable message', () => {
    expect(() => translate('SELECT * FROM users WHERE email = ? COLLATE NOCASE')).toThrow(/lower\(email\)/);
    expect(() => translate('SELECT json_group_array(id) FROM sales')).toThrow(/json_agg/);
    expect(() =>
      translate("SELECT json_extract(payload_json,'$.total_cents') FROM approval_requests"),
    ).toThrow(/json_agg/);
    expect(() => translate('PRAGMA foreign_keys = ON')).toThrow(/PRAGMA/);
    expect(() => translate('SELECT IFNULL(notes, 0) FROM products')).toThrow(/COALESCE/);
    expect(() => translate("SELECT strftime('%Y-%m', created_at) FROM sales")).toThrow(/to_char/);
    expect(() => translate('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT)')).toThrow(/IDENTITY/);
  });

  it('passes valid PostgreSQL through untouched', () => {
    const sql =
      'INSERT INTO sales (id, total_cents) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id';
    expect(translate(sql)).toBe(sql);
  });
});
