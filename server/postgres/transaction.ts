import { AsyncLocalStorage } from 'node:async_hooks';
import { getPool } from './db.js';
import { all, exec, insert, normaliseParams, one, scalar, translate } from './query.js';
import type { Executor, Params, Row } from './query.js';

/**
 * Transactions for the PostgreSQL ledger.
 *
 * The rule that matters for money: every statement in one financial unit of work must run on
 * the SAME connection. Acquiring a fresh pool client per statement would let a concurrent
 * request observe (or worse, write) half of a sale. `transaction()` therefore checks out one
 * client, runs BEGIN once, hands the same client to every helper, and COMMITs or ROLLBACKs
 * the whole unit before releasing it.
 *
 * Nesting mirrors the SQLite behaviour of `better-sqlite3` transactions: an inner
 * `transaction()` inside an outer one becomes a SAVEPOINT, so a failed inner unit can be
 * rolled back without discarding the outer one (used by the stock engine's retry loop).
 *
 * Row locking: `SELECT ... FOR UPDATE` inside a transaction is the PostgreSQL equivalent of
 * SQLite's whole-database write lock. Lock stock rows in a deterministic order (product_id)
 * to avoid deadlocks between two concurrent sales touching the same basket.
 */

export type Isolation = 'read committed' | 'repeatable read' | 'serializable';

export type Tx = Executor & {
  all: <T = Row>(sql: string, ...params: Params) => Promise<T[]>;
  one: <T = Row>(sql: string, ...params: Params) => Promise<T | null>;
  scalar: <T = unknown>(sql: string, ...params: Params) => Promise<T | null>;
  exec: (sql: string, ...params: Params) => Promise<number>;
  insert: (table: string, values: Row, options?: { onConflict?: string }) => Promise<number>;
  /** Locks rows for the duration of the transaction and returns them. */
  forUpdate: <T = Row>(sql: string, ...params: Params) => Promise<T[]>;
  /** Locks the inventory positions for the given products, in a deterministic order. */
  lockInventory: (businessId: string, branchId: string, productIds: string[]) => Promise<Row[]>;
  /** Runs `fn` inside a SAVEPOINT; a throw rolls back only the savepoint. */
  savepoint: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  readonly client: import('pg').PoolClient;
};

const ambient = new AsyncLocalStorage<Tx>();

/** The transaction currently in progress, if any. */
export function currentTransaction(): Tx | undefined {
  return ambient.getStore();
}

export type TransactionOptions = {
  isolation?: Isolation;
  readOnly?: boolean;
  /** Marks the transaction as a nested savepoint even when one is not in progress (test hook). */
  name?: string;
};

let savepointCounter = 0;

export async function transaction<T>(
  fn: (tx: Tx) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const existing = ambient.getStore();
  if (existing) return existing.savepoint(fn);

  const client = await getPool().connect();
  let finished = false;
  const tx = createTx(client, () => finished);
  try {
    const mode = options.isolation ? ` ISOLATION LEVEL ${options.isolation.toUpperCase()}` : '';
    const readOnly = options.readOnly ? ' READ ONLY' : '';
    await client.query(`BEGIN${mode}${readOnly}`);
    const result = await ambient.run(tx, () => fn(tx));
    finished = true;
    await client.query('COMMIT');
    return result;
  } catch (error) {
    finished = true;
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // The connection is unusable; report the original failure, which is the meaningful one.
      console.error('[postgres] rollback failed:', (rollbackError as Error).message);
    }
    throw error;
  } finally {
    client.release();
  }
}

function createTx(client: import('pg').PoolClient, isFinished: () => boolean): Tx {
  const guard = () => {
    if (isFinished())
      throw new Error('Transaction has already completed; reuse of its connection is not allowed');
  };
  const tx: Tx = {
    client,
    query: async (text: string, values?: Params) => {
      guard();
      return client.query(translate(text), normaliseParams(values ?? [])) as never;
    },
    all: async <T = Row>(sql: string, ...params: Params) => {
      guard();
      return all<T>(client, sql, ...params);
    },
    one: async <T = Row>(sql: string, ...params: Params) => {
      guard();
      return one<T>(client, sql, ...params);
    },
    scalar: async <T = unknown>(sql: string, ...params: Params) => {
      guard();
      return scalar<T>(client, sql, ...params);
    },
    exec: async (sql: string, ...params: Params) => {
      guard();
      return exec(client, sql, ...params);
    },
    insert: async (table: string, values: Row, options?: { onConflict?: string }) => {
      guard();
      return insert(client, table, values, options);
    },
    forUpdate: async <T = Row>(sql: string, ...params: Params) => {
      guard();
      if (!/^\s*SELECT/i.test(sql)) throw new Error('forUpdate requires a SELECT statement');
      if (/\bFOR\s+(UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)\b/i.test(sql)) {
        return all<T>(client, sql, ...params);
      }
      return all<T>(client, `${sql.replace(/;\s*$/, '')} FOR UPDATE`, ...params);
    },
    lockInventory: async (businessId: string, branchId: string, productIds: string[]) => {
      guard();
      const ids = [...new Set(productIds)].sort(); // deterministic order prevents deadlocks
      if (ids.length === 0) return [];
      const placeholders = ids.map((_, i) => `$${i + 3}`).join(', ');
      return tx.forUpdate(
        `SELECT * FROM inventory WHERE business_id=$1 AND branch_id=$2 AND product_id IN (${placeholders})`,
        businessId,
        branchId,
        ...ids,
      );
    },
    savepoint: async <R>(fn: (tx: Tx) => Promise<R>) => {
      guard();
      savepointCounter += 1;
      const name = `kilele_sp_${savepointCounter}`;
      await client.query(`SAVEPOINT ${name}`);
      try {
        const result = await ambient.run(tx, () => fn(tx));
        await client.query(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        await client.query(`RELEASE SAVEPOINT ${name}`);
        throw error;
      }
    },
  };
  return tx;
}

/**
 * Retries a serializable transaction on a serialization failure (40001) or deadlock (40P01).
 * Financial writes that use explicit FOR UPDATE locks normally stay at read committed; this
 * helper exists for the reports/analytics snapshot reads that want repeatable results.
 */
export async function withRetries<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const code = (error as { code?: string }).code;
      if ((code === '40001' || code === '40P01') && attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 10 * attempt));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}
