import 'dotenv/config';
import pg from 'pg';

/**
 * PostgreSQL connection layer for Kilele Retail OS.
 *
 * Rules this module enforces:
 *  1. The connection string is server-only. It is read from DATABASE_URL and must never be
 *     exposed through a VITE_* variable or shipped to the browser.
 *  2. `DATABASE_ENGINE=postgres` fails loudly until the Express modules have been converted
 *     to the async data layer. The server must never silently fall back to the SQLite file
 *     while claiming to run on PostgreSQL - that would put two ledgers in play.
 *  3. BIGINT values are parsed to JavaScript numbers. Kilele caps every monetary amount at
 *     1e12 cents (see shared/validation), which is far below Number.MAX_SAFE_INTEGER
 *     (9.007e15), so this is lossless - and it prevents the silent string concatenation
 *     that `pg` would otherwise produce for `SUM(total_cents)`.
 */

export type Engine = 'sqlite' | 'postgres';

/** Which storage engine the process has been configured to use. */
export const engine = (): Engine => {
  const configured = (process.env.DATABASE_ENGINE ?? 'sqlite').trim().toLowerCase();
  if (configured === 'postgres' || configured === 'postgresql') return 'postgres';
  if (configured === 'sqlite' || configured === '') return 'sqlite';
  throw new Error(
    `DATABASE_ENGINE must be "sqlite" or "postgres", received "${configured}". Refusing to start with an ambiguous storage engine.`,
  );
};

/**
 * The async PostgreSQL application layer is being migrated module by module. Until a module
 * is converted it still uses the synchronous better-sqlite3 helpers, so selecting postgres
 * before that work is complete must stop the process instead of serving a mixed ledger.
 *
 * Flip the entries in CONVERTED as each vertical slice lands (see docs/POSTGRES_MIGRATION.md).
 */
const CONVERTED_SLICES = new Set<string>([
  // 'health', 'bootstrap', 'auth', 'staff', 'products', 'inventory', 'sales',
  // 'purchases', 'approvals', 'reports'
]);

export function assertEngineUsable(slice = 'Express API'): void {
  if (engine() !== 'postgres') return;
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_ENGINE=postgres requires DATABASE_URL. Set it to the Supabase session connection string (server environment only).',
    );
  }
  if (!CONVERTED_SLICES.has(slice)) {
    throw new Error(
      `DATABASE_ENGINE=postgres is set but the "${slice}" module has not been converted to the async PostgreSQL data layer yet. ` +
        'The server refuses to start rather than silently serving the SQLite ledger. ' +
        'Keep DATABASE_ENGINE=sqlite (or unset) until the slice is migrated - see docs/POSTGRES_MIGRATION.md.',
    );
  }
}

/** Marks a vertical slice as converted; called from the slice's own module during migration. */
export function markSliceConverted(slice: string): void {
  CONVERTED_SLICES.add(slice);
}

export const convertedSlices = (): string[] => [...CONVERTED_SLICES].sort();

// ---------------------------------------------------------------------------
// Type parsers
// ---------------------------------------------------------------------------
const INT8_OID = 20;
const NUMERIC_OID = 1700;

let parsersInstalled = false;
export function installTypeParsers(): void {
  if (parsersInstalled) return;
  parsersInstalled = true;
  // int8/bigint: our money and quantity columns. Values above MAX_SAFE_INTEGER are rejected
  // rather than silently rounded, because a wrong total is worse than a loud failure.
  pg.types.setTypeParser(INT8_OID, (value) => {
    if (value === null) return null;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error(`PostgreSQL bigint value ${value} exceeds the safe integer range for money arithmetic`);
    }
    return parsed;
  });
  // numeric: not used by the v1 schema (money stays in integer cents) but parsed the same way
  // so a future aggregate cannot leak a string into arithmetic.
  pg.types.setTypeParser(NUMERIC_OID, (value) => (value === null ? null : Number(value)));
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------
export type PoolSettings = {
  connectionString: string;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  ssl?: { rejectUnauthorized: boolean };
  application_name: string;
  /** PostgreSQL startup options; used to pin `search_path` for tests and staging schemas. */
  options?: string;
};

export function poolSettings(env: NodeJS.ProcessEnv = process.env): PoolSettings {
  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. It must be a server-only PostgreSQL connection string.');
  }
  if (/^file:|\.sqlite/i.test(connectionString)) {
    throw new Error(
      'DATABASE_URL points at a SQLite file; PostgreSQL mode requires a postgres:// connection string.',
    );
  }
  const max = Number(env.DATABASE_POOL_MAX ?? 10);
  if (!Number.isInteger(max) || max < 1 || max > 100) {
    throw new Error(
      `DATABASE_POOL_MAX must be an integer between 1 and 100, received "${env.DATABASE_POOL_MAX}"`,
    );
  }
  // Supabase requires TLS. `require` accepts the managed certificate; `verify-full`
  // additionally validates the chain and hostname and should be used whenever the
  // platform CA bundle is available.
  const mode = (env.DATABASE_SSL ?? '').trim().toLowerCase();
  const ssl =
    mode === '' || mode === 'disable' || mode === 'false' || mode === 'off'
      ? undefined
      : { rejectUnauthorized: mode === 'verify-full' || mode === 'verify-ca' || mode === 'true' };
  // Pinning search_path lets the PostgreSQL test suite run against a scratch schema inside one
  // database (a Supabase project has a single database, so tests cannot each create one).
  // The value is validated as an identifier because it is interpolated into startup options.
  const searchPath = env.DATABASE_SEARCH_PATH?.trim();
  if (searchPath && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(searchPath)) {
    throw new Error(`DATABASE_SEARCH_PATH must be a single SQL identifier, received "${searchPath}"`);
  }
  return {
    connectionString,
    max,
    idleTimeoutMillis: Number(env.DATABASE_IDLE_TIMEOUT_MS ?? 30_000),
    connectionTimeoutMillis: Number(env.DATABASE_CONNECTION_TIMEOUT_MS ?? 10_000),
    ssl,
    application_name: env.DATABASE_APPLICATION_NAME ?? 'kilele-retail-os',
    options: searchPath ? `-csearch_path=${searchPath}` : undefined,
  };
}

let pool: pg.Pool | null = null;

/** Returns the process-wide pool, creating it on first use. */
export function getPool(): pg.Pool {
  if (pool) return pool;
  installTypeParsers();
  const settings = poolSettings();
  pool = new pg.Pool(settings);
  pool.on('error', (error) => {
    // An idle client failed (network blip, Supabase restart). Log and let the pool replace it;
    // crashing the API on an idle-connection error would take the till offline.
    console.error('[postgres] idle client error:', error.message);
  });
  return pool;
}

/** Test hook: replaces the pool (used by the PostgreSQL test harness). */
export function setPool(next: pg.Pool | null): void {
  pool = next;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const closing = pool;
  pool = null;
  await closing.end();
}

/** Round-trip check used by /healthz and by the migration CLI. */
export async function ping(): Promise<{ ok: true; version: string; database: string }> {
  const client = await getPool().connect();
  try {
    const result = await client.query('SELECT current_database() AS database, version() AS version');
    return {
      ok: true,
      version: result.rows[0].version as string,
      database: result.rows[0].database as string,
    };
  } finally {
    client.release();
  }
}

export { pg };
export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
