import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { getPool, installTypeParsers } from './db.js';

/**
 * Versioned PostgreSQL migrations.
 *
 * Every schema change lives in Git under server/postgres/migrations and is applied by this
 * runner - never by pasting SQL into the Supabase dashboard. That keeps a deployed database
 * reproducible from a clean checkout and makes the change reviewable in the pull request.
 *
 * Guarantees:
 *  * each file runs inside a single transaction, so a failure rolls the whole file back and
 *    leaves the database at the previous version;
 *  * a fixed advisory lock serialises concurrent deploys (Render can start several instances
 *    at once) so two processes cannot apply the same migration twice;
 *  * the SHA-256 of every applied file is stored, and a changed checksum for an already
 *    applied migration is a hard error - history is append-only, corrections go in a new file;
 *  * running the runner again is a no-op.
 */

export type Migration = { name: string; sql: string; checksum: string };
export type AppliedMigration = { name: string; applied_at: string; checksum: string; duration_ms: number };

const MIGRATION_FILE = /^[0-9]{3}_[a-z0-9_]+\.sql$/;
/** Arbitrary but fixed: serialises migrations across processes on the same database. */
const ADVISORY_LOCK_KEY = 7_423_001;

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Locates the migrations directory. The compiled bundle in dist/server/postgres does not carry
 * the .sql files unless the build copies them, so the source tree and the repository root are
 * tried as well - and if none of them exists the failure names every path it looked in rather
 * than reporting a bare ENOENT during a deploy.
 */
export async function migrationsDir(): Promise<string> {
  const candidates = [
    fileURLToPath(new URL('./migrations', import.meta.url)),
    fileURLToPath(new URL('../../../server/postgres/migrations', import.meta.url)),
    resolve(process.cwd(), 'server/postgres/migrations'),
  ];
  for (const candidate of candidates) if (await isDirectory(candidate)) return candidate;
  throw new Error(
    `Cannot find the PostgreSQL migrations directory. Looked in: ${candidates.join(', ')}. ` +
      'The build must copy server/postgres/migrations next to the compiled CLI.',
  );
}

export async function readMigrations(dir?: string): Promise<Migration[]> {
  const resolved = dir ?? (await migrationsDir());
  const entries = await readdir(resolved);
  const files = entries.filter((name) => MIGRATION_FILE.test(name)).sort();
  const unexpected = entries.filter((name) => !MIGRATION_FILE.test(name) && !name.startsWith('.'));
  if (unexpected.length) {
    throw new Error(
      `Unexpected files in ${resolved}: ${unexpected.join(', ')}. Migration files must be named NNN_description.sql so they apply in order.`,
    );
  }
  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(`${resolved}/${name}`, 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

async function ensureLedger(client: import('pg').PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS pg_schema_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      duration_ms BIGINT NOT NULL
    )
  `);
}

export async function appliedMigrations(): Promise<AppliedMigration[]> {
  const client = await getPool().connect();
  try {
    await ensureLedger(client);
    const result = await client.query(
      'SELECT name, checksum, applied_at, duration_ms FROM pg_schema_migrations ORDER BY name',
    );
    return result.rows as AppliedMigration[];
  } finally {
    client.release();
  }
}

export type MigrateResult = {
  applied: string[];
  skipped: string[];
  dryRun: boolean;
};

/** Applies every migration that has not been recorded yet. */
export async function migrate(options: { dryRun?: boolean } = {}): Promise<MigrateResult> {
  installTypeParsers();
  const migrations = await readMigrations();
  const client = await getPool().connect();
  try {
    // Block until any other migrating process finishes; released automatically at disconnect.
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    try {
      await ensureLedger(client);
      const result = await client.query('SELECT name, checksum FROM pg_schema_migrations ORDER BY name');
      const applied = new Map<string, string>(
        result.rows.map((row) => [row.name as string, row.checksum as string]),
      );

      const done: string[] = [];
      const skipped: string[] = [];
      for (const migration of migrations) {
        const previousChecksum = applied.get(migration.name);
        if (previousChecksum !== undefined) {
          if (previousChecksum !== migration.checksum) {
            throw new Error(
              `Migration ${migration.name} has already been applied with checksum ${previousChecksum.slice(0, 12)}… ` +
                `but the file now hashes to ${migration.checksum.slice(0, 12)}…. ` +
                'Applied migrations must never be edited; add a new migration file instead.',
            );
          }
          skipped.push(migration.name);
          continue;
        }
        if (options.dryRun) {
          done.push(migration.name);
          continue;
        }
        const started = Date.now();
        // One transaction per file. `client.query(sql)` with no parameters uses the simple
        // query protocol, which is what allows multiple statements and $$-quoted functions.
        await client.query('BEGIN');
        try {
          await client.query(migration.sql);
          await client.query(
            'INSERT INTO pg_schema_migrations (name, checksum, applied_at, duration_ms) VALUES ($1, $2, $3, $4)',
            [migration.name, migration.checksum, new Date().toISOString(), Date.now() - started],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`Migration ${migration.name} failed and was rolled back: ${detail}`, {
            cause: error,
          });
        }
        done.push(migration.name);
      }
      return { applied: done, skipped, dryRun: options.dryRun === true };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

/** Migrations present on disk but not yet applied - what a deploy is about to do. */
export async function pendingMigrations(): Promise<string[]> {
  const [migrations, applied] = await Promise.all([readMigrations(), appliedMigrations()]);
  const names = new Set(applied.map((row) => row.name));
  return migrations.filter((migration) => !names.has(migration.name)).map((migration) => migration.name);
}
