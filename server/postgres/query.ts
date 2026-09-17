import { getPool } from './db.js';
import type { PoolClient } from './db.js';

/**
 * Async query helpers - the PostgreSQL counterpart of the synchronous `one`/`all`/`insert`
 * helpers in server/db.ts.
 *
 * Deliberate design decisions:
 *  * Call sites keep writing `?` placeholders; `translate()` rewrites them to `$1..$n`.
 *    That makes the Slice-by-Slice conversion mechanical and reviewable.
 *  * SQLite-only syntax is REJECTED, not silently rewritten. `INSERT OR REPLACE` in
 *    particular is an upsert that deletes and re-inserts a row, which would destroy
 *    immutable financial records and evade every guard trigger. `INSERT OR IGNORE` must be
 *    written as an explicit `ON CONFLICT DO NOTHING` so the conflict target is visible in
 *    review.
 *  * Every helper returns plain rows; there is no ORM and no query builder in the money path.
 */

export type Row = Record<string, unknown>;
export type Params = unknown[];

/** Executor: the pool for one-shot queries, or a single client inside a transaction. */
export type Executor = {
  query: (text: string, values?: Params) => Promise<{ rows: Row[]; rowCount: number | null }>;
};

const SQLITE_ONLY_PATTERNS: Array<[RegExp, string]> = [
  [
    /\bINSERT\s+OR\s+REPLACE\b/i,
    'INSERT OR REPLACE deletes and re-inserts a row, which would evade the immutability triggers. Write an explicit upsert with ON CONFLICT ... DO UPDATE, or refuse the operation.',
  ],
  [
    /\bINSERT\s+OR\s+IGNORE\b/i,
    'INSERT OR IGNORE hides constraint violations. Write INSERT ... ON CONFLICT DO NOTHING with an explicit conflict target.',
  ],
  [
    /\bINSERT\s+OR\s+(ABORT|FAIL|ROLLBACK)\b/i,
    'SQLite conflict clauses are not supported; write an explicit ON CONFLICT clause.',
  ],
  [
    /\bPRAGMA\b/i,
    'PRAGMA is SQLite-only. PostgreSQL equivalents are settings in the connection string or SHOW statements.',
  ],
  [
    /\bjson_group_array\b|\bjson_group_object\b|\bjson_extract\b/i,
    'SQLite JSON functions are not supported; use json_agg / json_build_object / ->> instead.',
  ],
  [/\bIFNULL\s*\(/i, 'IFNULL is SQLite-only; use COALESCE.'],
  [
    /\bCOLLATE\s+NOCASE\b/i,
    'COLLATE NOCASE is SQLite-only. Emails are stored lower-cased: compare with lower(email) = lower($1), which uses the users_email_ci_unique / idx_invites_email expression indexes.',
  ],
  [
    /\bRETURNING\s+last_insert_rowid\b|\blast_insert_rowid\s*\(/i,
    'last_insert_rowid() is SQLite-only; use RETURNING on the seq identity column.',
  ],
  [
    /\bstrftime\s*\(|\bjulianday\s*\(|\bunixepoch\s*\(/i,
    'SQLite date functions are not supported; use to_char / date_trunc / EXTRACT.',
  ],
  [/\bAUTOINCREMENT\b/i, 'AUTOINCREMENT is SQLite-only; use GENERATED ALWAYS AS IDENTITY.'],
  [/\bRETURNING\s+rowid\b/i, 'rowid does not exist; return the explicit seq identity column instead.'],
];

/**
 * Rewrites `?` placeholders to PostgreSQL `$n`, and refuses SQLite-only syntax.
 * Placeholders inside string literals and comments are left alone.
 */
export function translate(sql: string): string {
  for (const [pattern, message] of SQLITE_ONLY_PATTERNS) {
    if (pattern.test(sql)) throw new Error(`Unsupported SQLite syntax in PostgreSQL mode: ${message}`);
  }
  let out = '';
  let index = 0;
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    if (char === "'") {
      // Copy a single-quoted literal verbatim, honouring '' as an escaped quote.
      out += char;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            out += "''";
            i += 2;
            continue;
          }
          out += "'";
          i += 1;
          break;
        }
        out += sql[i];
        i += 1;
      }
      continue;
    }
    if (char === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (char === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (char === '"') {
      // Quoted identifier.
      const end = sql.indexOf('"', i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (char === '?') {
      index += 1;
      out += `$${index}`;
      i += 1;
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

/** Normalises a value for `pg`: Date objects are converted to ISO text because every
 *  timestamp column in the schema is TEXT, matching the SQLite ledger. */
export function normaliseParams(params: Params = []): Params {
  return params.map((value) => {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'boolean') return value ? 1 : 0; // flags stay INTEGER 0/1 in v1
    if (value === undefined) return null;
    return value;
  });
}

async function run(executor: Executor, sql: string, params: Params = []) {
  const result = await executor.query(translate(sql), normaliseParams(params));
  return result;
}

/** All matching rows, in the order the query specifies. */
export async function all<T = Row>(executor: Executor, sql: string, ...params: Params): Promise<T[]> {
  const result = await run(executor, sql, params);
  return result.rows as T[];
}

/** The first matching row, or null. Throws if the query returns more than one row, because
 *  "one" in this codebase always means a uniquely identified record. */
export async function one<T = Row>(executor: Executor, sql: string, ...params: Params): Promise<T | null> {
  const rows = await all<T>(executor, sql, ...params);
  if (rows.length > 1) throw new Error(`Expected at most one row but received ${rows.length}`);
  return rows[0] ?? null;
}

/** The first column of the first row, or null. */
export async function scalar<T = unknown>(
  executor: Executor,
  sql: string,
  ...params: Params
): Promise<T | null> {
  const row = await one<Row>(executor, sql, ...params);
  if (!row) return null;
  const [value] = Object.values(row);
  return (value ?? null) as T | null;
}

/** A statement whose rows are not needed. Returns the affected row count. */
export async function exec(executor: Executor, sql: string, ...params: Params): Promise<number> {
  const result = await run(executor, sql, params);
  return result.rowCount ?? 0;
}

/** Builds `INSERT INTO table (cols) VALUES (...)` from a record, mirroring server/db.ts. */
export function insertSql(
  table: string,
  values: Row,
  options: { onConflict?: string; returning?: string } = {},
) {
  const columns = Object.keys(values);
  if (columns.length === 0) throw new Error(`insert into ${table} requires at least one column`);
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error(`Refusing to build SQL for table name "${table}"`);
  for (const column of columns) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(column))
      throw new Error(`Refusing to build SQL for column name "${column}"`);
  }
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  let sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;
  if (options.onConflict) sql += ` ON CONFLICT ${options.onConflict}`;
  if (options.returning) sql += ` RETURNING ${options.returning}`;
  return { sql, params: normaliseParams(columns.map((column) => values[column])) };
}

/** Inserts a record. `onConflict` must be an explicit clause, e.g. `(id) DO NOTHING`. */
export async function insert(
  executor: Executor,
  table: string,
  values: Row,
  options?: { onConflict?: string },
): Promise<number> {
  const { sql, params } = insertSql(table, values, options);
  const result = await executor.query(sql, params);
  return result.rowCount ?? 0;
}

/** Convenience executor bound to the shared pool. */
export const poolExecutor = (): Executor => getPool();

/** One-shot helpers against the pool. Inside a transaction use the Tx object instead. */
export const dbAll = <T = Row>(sql: string, ...params: Params) => all<T>(getPool(), sql, ...params);
export const dbOne = <T = Row>(sql: string, ...params: Params) => one<T>(getPool(), sql, ...params);
export const dbScalar = <T = unknown>(sql: string, ...params: Params) => scalar<T>(getPool(), sql, ...params);
export const dbExec = (sql: string, ...params: Params) => exec(getPool(), sql, ...params);
export const dbInsert = (table: string, values: Row, options?: { onConflict?: string }) =>
  insert(getPool(), table, values, options);

export type { PoolClient };
