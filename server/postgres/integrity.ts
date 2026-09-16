import { all, one } from './query.js';
import { getPool } from './db.js';

/**
 * Verifies that a PostgreSQL database actually carries every financial protection the
 * SQLite ledger enforces. Migrations can be applied to the wrong database, a trigger can be
 * dropped by hand, or a Supabase project can be created from the dashboard instead of from
 * these files - so the guarantees are re-checked at bootstrap and on demand rather than
 * assumed.
 *
 * This is the PostgreSQL answer to "PRAGMA foreign_keys=ON": instead of trusting a setting,
 * the schema itself is interrogated.
 */

/** Tables whose rows may never be updated or deleted once written. */
export const IMMUTABLE_TABLES = [
  'environment_markers',
  'purchase_reversals',
  'supplier_refunds',
  'supplier_payment_reversals',
  'reconciliation_adjustments',
  'sales',
  'sale_items',
  'payments',
  'expenses',
  'expense_reversals',
  'sale_reversals',
  'sale_return_items',
  'purchases',
  'purchase_items',
  'purchase_receipts',
  'supplier_payments',
  'inventory_movements',
  'reconciliations',
  'documents',
  'journal_entries',
  'journal_lines',
  'audit_logs',
  'price_history',
  'approval_events',
  'idempotency_keys',
] as const;

/**
 * Every trigger the ledger depends on: [table, trigger name].
 * The immutable guards keep SQLite's one-trigger-per-operation naming so the same list
 * validates either engine.
 */
export const REQUIRED_TRIGGERS: Array<[string, string]> = [
  ...IMMUTABLE_TABLES.flatMap((table) => [
    [table, `immutable_${table}_update`] as [string, string],
    [table, `immutable_${table}_delete`] as [string, string],
  ]),
  ['inventory', 'inventory_initial_zero'],
  ['inventory', 'inventory_cannot_delete'],
  ['inventory', 'inventory_only_from_ledger'],
  ['inventory_movements', 'movement_matches_inventory'],
  ['inventory_movements', 'movement_updates_inventory'],
  ['approval_requests', 'approval_preserve_original'],
  ['approval_requests', 'approval_no_terminal_update'],
  ['approval_requests', 'approval_no_delete'],
  ['cash_sessions', 'cash_session_preserve'],
  ['cash_sessions', 'cash_session_no_delete'],
  ['user_invites', 'invite_preserve_terms'],
  ['user_invites', 'invite_no_terminal_update'],
  ['user_invites', 'invite_no_delete'],
  ['purchases', 'active_purchase_invoice'],
  ['products', 'product_price_guard'],
];

/** Uniqueness guarantees that must exist as indexes (schema.sql + the PostgreSQL additions). */
export const REQUIRED_UNIQUE_INDEXES = [
  'one_open_session_per_register',
  'one_open_session_per_user',
  'open_register_name_normalized',
  'unique_payment_ref',
  'one_purchase_replacement',
  'users_email_ci_unique',
];

/** Lookup indexes the reports and the guards depend on. */
export const REQUIRED_INDEXES = [
  'idx_sales_scope_date',
  'idx_sales_staff',
  'idx_items_product',
  'idx_products_scope',
  'idx_movements_product_date',
  'idx_approvals_scope',
  'idx_expenses_scope',
  'idx_payments_session',
  'idx_audit_scope',
  'idx_purchases_scope',
  'idx_journal_scope',
  'idx_invites_scope',
  'idx_invites_email',
  'purchase_invoice_lookup',
  'idx_inventory_movements_position',
  'idx_price_history_product_seq',
];

/** Columns that must stay 64-bit integers so money arithmetic can never become a string. */
export const REQUIRED_BIGINT_COLUMNS: Array<[string, string]> = [
  ['sales', 'total_cents'],
  ['sale_items', 'total_cents'],
  ['payments', 'amount_cents'],
  ['expenses', 'amount_cents'],
  ['purchases', 'total_cents'],
  ['inventory', 'quantity'],
  ['inventory', 'value_cents'],
  ['inventory_movements', 'quantity'],
  ['journal_lines', 'debit_cents'],
  ['cash_sessions', 'opening_cents'],
];

/** Columns that must be identity-generated because a trigger depends on insertion order. */
export const REQUIRED_SEQUENCE_COLUMNS: Array<[string, string]> = [
  ['inventory_movements', 'seq'],
  ['price_history', 'seq'],
  ['audit_logs', 'seq'],
];

export type ProtectionReport = {
  ok: boolean;
  missing: string[];
  counts: { triggers: number; uniqueIndexes: number; foreignKeys: number; tables: number };
};

async function installedTriggers(): Promise<Set<string>> {
  const rows = await all<{ table_name: string; trigger_name: string }>(
    getPool(),
    `SELECT c.relname AS table_name, t.tgname AS trigger_name
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname = current_schema()`,
  );
  return new Set(rows.map((row) => `${row.table_name}.${row.trigger_name}`));
}

async function installedUniqueIndexes(): Promise<Set<string>> {
  const rows = await all<{ indexname: string }>(
    getPool(),
    `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`,
  );
  return new Set(rows.map((row) => row.indexname));
}

export async function verifyProtections(): Promise<ProtectionReport> {
  const missing: string[] = [];

  const triggers = await installedTriggers();
  for (const [table, trigger] of REQUIRED_TRIGGERS) {
    if (!triggers.has(`${table}.${trigger}`)) missing.push(`trigger ${table}.${trigger}`);
  }

  const indexes = await installedUniqueIndexes();
  for (const index of [...REQUIRED_UNIQUE_INDEXES, ...REQUIRED_INDEXES]) {
    if (!indexes.has(index)) missing.push(`index ${index}`);
  }

  for (const [table, column] of REQUIRED_BIGINT_COLUMNS) {
    const row = await one<{ data_type: string }>(
      getPool(),
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?`,
      table,
      column,
    );
    if (!row) missing.push(`column ${table}.${column}`);
    else if (row.data_type !== 'bigint')
      missing.push(`column ${table}.${column} is ${row.data_type}, expected bigint`);
  }

  for (const [table, column] of REQUIRED_SEQUENCE_COLUMNS) {
    const row = await one<{ is_identity: string }>(
      getPool(),
      `SELECT is_identity FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?`,
      table,
      column,
    );
    if (!row) missing.push(`identity column ${table}.${column}`);
    else if (row.is_identity !== 'YES') missing.push(`${table}.${column} is not an identity column`);
  }

  const tables = await all<{ tablename: string }>(
    getPool(),
    `SELECT tablename FROM pg_tables WHERE schemaname = current_schema()`,
  );
  const foreignKeys = await all<{ conname: string }>(
    getPool(),
    `SELECT conname FROM pg_constraint
      WHERE contype = 'f' AND connamespace = current_schema()::regnamespace`,
  );
  const tableNames = new Set(tables.map((row) => row.tablename));
  for (const table of IMMUTABLE_TABLES) {
    if (!tableNames.has(table)) missing.push(`table ${table}`);
  }

  return {
    ok: missing.length === 0,
    missing,
    counts: {
      triggers: triggers.size,
      uniqueIndexes: indexes.size,
      foreignKeys: foreignKeys.length,
      tables: tableNames.size,
    },
  };
}

/** Throws with the full list of absent protections; used by bootstrap and the CLI. */
export async function assertProtections(): Promise<ProtectionReport> {
  const report = await verifyProtections();
  if (!report.ok) {
    throw new Error(
      `PostgreSQL schema is missing ${report.missing.length} financial protection(s): ${report.missing.join('; ')}. ` +
        'Run `npm run db:pg:migrate` against this database before serving traffic.',
    );
  }
  return report;
}
