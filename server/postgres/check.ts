import { roundRatio, sha } from '../core.js';
import { getPool } from './db.js';
import { all, one } from './query.js';
import { transaction } from './transaction.js';
import { verifyProtections } from './integrity.js';

// Money rounding and hashing come from core.ts rather than being reimplemented here: both are
// pure (BigInt round-half-up, sha256) and core.ts has no runtime dependency on better-sqlite3,
// so the two engines share one definition and cannot drift on tax arithmetic or audit hashes.
export { roundRatio };

/**
 * PostgreSQL ledger integrity check - the counterpart of `integrity()` in server/core.ts.
 *
 * Two differences from the SQLite version, both deliberate:
 *  1. The recomputations are set-based SQL instead of a row-by-row loop, so a whole business
 *     is verified in a handful of queries rather than thousands. Error MESSAGES are copied
 *     verbatim from core.ts so a report reads identically on either engine.
 *  2. The result states its own coverage. Not every core.ts check is ported yet; the ones that
 *     are not are listed in `pending` rather than being quietly omitted, because an integrity
 *     report that looks complete while skipping purchases would be worse than no report.
 *
 * Physical checks are not portable: `PRAGMA integrity_check` and `PRAGMA foreign_key_check`
 * have no PostgreSQL equivalent that a client can run (foreign keys are always enforced, and
 * page-level verification is the platform's job - Supabase runs it, self-hosting uses
 * pg_amcheck). `verifyProtections()` replaces them by proving the guards are installed.
 */

export type IntegrityContext = { business_id: string; branch_id: string };
export type IntegrityResult = {
  ok: boolean;
  errors: string[];
  checks: { ran: string[]; pending: string[] };
  counts: { triggers: number; uniqueIndexes: number; foreignKeys: number; tables: number };
};

/** Scope clause builder: every check can run for the whole database or for one branch. */
const scope = (context: IntegrityContext | undefined, alias: string) =>
  context
    ? {
        sql: ` AND ${alias}.business_id = $1 AND ${alias}.branch_id = $2`,
        params: [context.business_id, context.branch_id],
      }
    : { sql: '', params: [] as unknown[] };

/**
 * The audit chain: each row hashes the previous row's hash, so any edit, deletion or reorder
 * breaks verification. The column list is explicit (not SELECT *) because the hash covers
 * JSON.stringify of the row without seq/hash, and key order must match what audit() wrote.
 */
export async function verifyAudit(context?: IntegrityContext): Promise<string[]> {
  const errors: string[] = [];
  const fields = [
    'id',
    'business_id',
    'branch_id',
    'user_id',
    'role',
    'action',
    'entity',
    'entity_id',
    'before_json',
    'after_json',
    'reason',
    'approval_id',
    'ip',
    'device',
    'created_at',
    'previous_hash',
  ];
  const rows = await all<Record<string, unknown>>(
    getPool(),
    `SELECT seq, hash, ${fields.join(', ')} FROM audit_logs ORDER BY seq`,
  );
  let previous = 'GENESIS';
  for (const row of rows) {
    const entry: Record<string, unknown> = {};
    for (const field of fields) entry[field] = row[field] ?? null;
    const inScope =
      !context || (row.business_id === context.business_id && row.branch_id === context.branch_id);
    if (inScope && (entry.previous_hash !== previous || sha(JSON.stringify(entry)) !== row.hash)) {
      errors.push(`Audit chain mismatch at ${row.seq}`);
    }
    previous = row.hash as string;
  }
  return errors;
}

export async function integrity(context?: IntegrityContext): Promise<IntegrityResult> {
  const errors: string[] = [];
  const ran: string[] = [];
  const error = (message: string) => {
    if (!errors.includes(message)) errors.push(message);
  };

  // Runs every recomputation on one snapshot so a concurrent sale cannot make two checks
  // disagree with each other.
  await transaction(
    async (tx) => {
      // 1. Double entry must balance.
      ran.push('journal balance');
      const s1 = scope(context, 'l');
      const unbalanced = await all<{ entry_id: string }>(
        tx,
        `SELECT l.entry_id FROM journal_lines l WHERE TRUE${s1.sql} GROUP BY l.entry_id HAVING SUM(l.debit_cents) <> SUM(l.credit_cents)`,
        ...s1.params,
      );
      if (unbalanced.length) error('Unbalanced journals');

      ran.push('journal completeness');
      const s2 = scope(context, 'e');
      const empty = await all<{ id: string }>(
        tx,
        `SELECT e.id FROM journal_entries e WHERE NOT EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id = e.id)${s2.sql}`,
        ...s2.params,
      );
      if (empty.length) error('Empty journal entry');

      // 2. Inventory must equal the movement ledger, including the version counter.
      ran.push('inventory vs movement ledger');
      const s3 = scope(context, 'i');
      const drifted = await all<{ product_id: string }>(
        tx,
        `SELECT i.product_id
         FROM inventory i
         LEFT JOIN inventory_movements m
           ON m.business_id = i.business_id AND m.branch_id = i.branch_id AND m.product_id = i.product_id
        WHERE TRUE${s3.sql}
        GROUP BY i.business_id, i.branch_id, i.product_id, i.quantity, i.value_cents, i.version
       HAVING i.quantity <> COALESCE(SUM(m.quantity), 0)
           OR i.value_cents <> COALESCE(SUM(m.value_delta_cents), 0)
           OR i.version <> COUNT(m.id)`,
        ...s3.params,
      );
      if (drifted.length) error('Inventory balance/version does not match its movement ledger');

      // 3. Sale headers must equal the sum of their items (an itemless sale sums to zero).
      ran.push('sale header vs items');
      const s4 = scope(context, 's');
      const headerDrift = await all<{ id: string }>(
        tx,
        `SELECT s.id FROM sales s
         LEFT JOIN (
           SELECT sale_id, SUM(subtotal_cents) subtotal_cents, SUM(discount_cents) discount_cents,
                  SUM(total_cents) total_cents, SUM(tax_cents) tax_cents, SUM(cogs_cents) cogs_cents
             FROM sale_items GROUP BY sale_id
         ) l ON l.sale_id = s.id
        WHERE TRUE${s4.sql}
          AND (s.subtotal_cents <> COALESCE(l.subtotal_cents, 0) OR s.discount_cents <> COALESCE(l.discount_cents, 0)
            OR s.total_cents <> COALESCE(l.total_cents, 0) OR s.tax_cents <> COALESCE(l.tax_cents, 0)
            OR s.cogs_cents <> COALESCE(l.cogs_cents, 0))`,
        ...s4.params,
      );
      if (headerDrift.length) error('Sale header does not match recorded sale items');

      // 4. Every recorded line must still satisfy the pricing/tax snapshot arithmetic.
      ran.push('sale item price/tax snapshot');
      const s5 = scope(context, 'si');
      const items = await all<Record<string, never>>(
        tx,
        `SELECT si.* FROM sale_items si WHERE TRUE${s5.sql}`,
        ...s5.params,
      );
      for (const line of items as Array<Record<string, number | string>>) {
        try {
          const base = (line.unit_price_cents as number) * (line.quantity as number);
          const taxMode = line.tax_mode as string;
          const taxBps = line.tax_bps as number;
          const charged = base + (taxMode === 'exclusive' ? roundRatio(base, taxBps, 10000) : 0);
          const tax = ['inclusive', 'exclusive'].includes(taxMode)
            ? roundRatio(line.total_cents as number, taxBps, 10000 + taxBps)
            : 0;
          if (
            charged !== line.subtotal_cents ||
            line.total_cents !== (line.subtotal_cents as number) - (line.discount_cents as number) ||
            tax !== line.tax_cents
          ) {
            error('Sale item price/tax snapshot arithmetic mismatch');
          }
        } catch {
          error('Invalid sale item monetary snapshot');
        }
      }

      // 5. Returns may never exceed what was sold.
      ran.push('sale returns within original allocation');
      const s6 = scope(context, 'si');
      const overReturned = await all<{ sale_item_id: string }>(
        tx,
        `SELECT si.id AS sale_item_id
         FROM sale_items si
         JOIN sale_return_items r ON r.sale_item_id = si.id
        WHERE TRUE${s6.sql}
        GROUP BY si.id, si.quantity, si.total_cents, si.tax_cents, si.cogs_cents
       HAVING SUM(r.quantity) > si.quantity OR SUM(r.total_cents) > si.total_cents
           OR SUM(r.tax_cents) > si.tax_cents OR SUM(r.cogs_cents) > si.cogs_cents`,
        ...s6.params,
      );
      if (overReturned.length) error('Sale return exceeds its original quantity or monetary allocation');

      // 6. Tenders must reconcile to the sale and its returns.
      ran.push('sale tenders reconcile');
      const s7 = scope(context, 's');
      const tenderDrift = await all<{ id: string }>(
        tx,
        `SELECT s.id FROM sales s
         LEFT JOIN (
           SELECT sale_id,
                  SUM(CASE WHEN reversal_id IS NULL THEN amount_cents ELSE 0 END) original,
                  SUM(amount_cents) net
             FROM payments GROUP BY sale_id
         ) p ON p.sale_id = s.id
         LEFT JOIN (SELECT sale_id, SUM(total_cents) n FROM sale_reversals GROUP BY sale_id) r ON r.sale_id = s.id
        WHERE TRUE${s7.sql}
          AND (COALESCE(p.original, 0) <> s.total_cents
            OR COALESCE(p.net, 0) <> s.total_cents - COALESCE(r.n, 0))`,
        ...s7.params,
      );
      if (tenderDrift.length) error('Sale tenders do not reconcile to sale and returns');

      // 7. Return headers and their refund tenders.
      ran.push('return header vs allocations');
      const s8 = scope(context, 'rv');
      const returnDrift = await all<{ id: string }>(
        tx,
        `SELECT rv.id FROM sale_reversals rv
         LEFT JOIN (
           SELECT reversal_id, SUM(total_cents) total_cents, SUM(tax_cents) tax_cents, SUM(cogs_cents) cogs_cents
             FROM sale_return_items GROUP BY reversal_id
         ) l ON l.reversal_id = rv.id
        WHERE TRUE${s8.sql}
          AND (COALESCE(l.total_cents, 0) <> rv.total_cents OR COALESCE(l.tax_cents, 0) <> rv.tax_cents
            OR COALESCE(l.cogs_cents, 0) <> rv.cogs_cents)`,
        ...s8.params,
      );
      if (returnDrift.length) error('Return header does not match its item allocations');

      ran.push('returns reconcile to refund tenders');
      const refundDrift = await all<{ id: string }>(
        tx,
        `SELECT rv.id FROM sale_reversals rv
         LEFT JOIN (SELECT reversal_id, SUM(amount_cents) n FROM payments GROUP BY reversal_id) p ON p.reversal_id = rv.id
        WHERE TRUE${s8.sql} AND COALESCE(p.n, 0) <> -rv.total_cents`,
        ...s8.params,
      );
      if (refundDrift.length) error('Return does not reconcile to refund tenders');

      // 8. Cash arithmetic on every tender.
      ran.push('tendered cash vs change');
      const s9 = scope(context, 'p');
      const cashDrift = await all<{ id: string }>(
        tx,
        `SELECT p.id FROM payments p
        WHERE p.reversal_id IS NULL AND p.tendered_cents - p.change_cents <> p.amount_cents${s9.sql}`,
        ...s9.params,
      );
      if (cashDrift.length) error('Tendered cash/change does not match payment');
    },
    { readOnly: true },
  );

  // 9. The audit hash chain (read outside the snapshot: it is append-only anyway).
  ran.push('audit hash chain');
  for (const message of await verifyAudit(context)) error(message);

  // 10. The database-level protections must still be installed.
  ran.push('schema protections');
  const protections = await verifyProtections();
  for (const missing of protections.missing) error(`Missing financial protection: ${missing}`);

  return {
    ok: errors.length === 0,
    errors,
    checks: {
      ran,
      pending: [
        'expense reversal vs original (core.ts: Expense reversal differs from original)',
        'purchase header/items reconciliation (core.ts: Purchase header/items do not reconcile)',
        'closing snapshot arithmetic (core.ts: Closing snapshot arithmetic mismatch)',
        'approval decision reviewer metadata (core.ts: Decision lacks independent reviewer metadata/history)',
        'journal lines vs the account map recomputation (core.ts ledger-to-account loop)',
        'supplier payment and refund reconciliation',
      ],
    },
    counts: protections.counts,
  };
}

/** Convenience for the CLI: prints the report and exits non-zero when it is not clean. */
export async function runIntegrityReport(context?: IntegrityContext): Promise<IntegrityResult> {
  const result = await integrity(context);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/** Single-value helper kept here so check callers do not need to import query.ts. */
export async function countRows(table: string): Promise<number> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error(`Refusing to count rows for "${table}"`);
  const row = await one<{ n: number }>(getPool(), `SELECT COUNT(*)::bigint AS n FROM ${table}`);
  return row?.n ?? 0;
}
