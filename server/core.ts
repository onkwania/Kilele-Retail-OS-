import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';

export type DB = Database.Database;
export type Row = Record<string, any>;
export type Actor = {
  id: string;
  business_id: string;
  branch_id: string;
  name: string;
  email: string;
  role_id: string;
  permissions: string[];
  ip?: string;
  device?: string;
  must_change_password?: number;
};
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'VALIDATION_ERROR',
  ) {
    super(message);
  }
}
export function requireThat(condition: unknown, message: string, status = 400): asserts condition {
  if (!condition) throw new AppError(status, message);
}
export const id = (prefix = '') => `${prefix}${randomUUID()}`;
export const now = () => new Date().toISOString();
export const kenyaDate = (date = new Date()) =>
  new Date(date.getTime() + 3 * 3600_000).toISOString().slice(0, 10);
export const ref = (prefix: string) =>
  `${prefix}-${kenyaDate().replaceAll('-', '')}-${randomUUID().slice(0, 8).toUpperCase()}`;
export const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const one = (db: DB, sql: string, ...args: any[]): Row | undefined =>
  db.prepare(sql).get(...args) as Row | undefined;
export const all = (db: DB, sql: string, ...args: any[]): Row[] => db.prepare(sql).all(...args) as Row[];
export function insert(db: DB, table: string, row: Row) {
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(
    ...keys.map((k) => row[k] ?? null),
  );
}
export const scope = (a: Actor) => ({ business_id: a.business_id, branch_id: a.branch_id });
export function scoped(db: DB, table: string, entityId: string, a: Actor, branch = true) {
  const row = one(
    db,
    `SELECT * FROM ${table} WHERE id=? AND business_id=?${branch ? ' AND branch_id=?' : ''}`,
    entityId,
    a.business_id,
    ...(branch ? [a.branch_id] : []),
  );
  requireThat(row, 'Record not found in your workspace.', 404);
  return row;
}
export const can = (a: Actor, permission: string) => a.permissions.includes(permission);
export const demand = (a: Actor, permission: string) =>
  requireThat(can(a, permission), 'You do not have permission for this action.', 403);
export const moneyInput = z
  .string()
  .trim()
  .regex(/^\d{1,9}(\.\d{1,2})?$/, 'Enter a positive KES amount with at most 2 decimal places.');
export function cents(input: string): number {
  const value = moneyInput.parse(input);
  const [whole, fraction = ''] = value.split('.');
  return Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')));
}
export const amount = (n: number) =>
  `${n < 0 ? '-' : ''}${Math.floor(Math.abs(n) / 100)}.${String(Math.abs(n) % 100).padStart(2, '0')}`;
export function roundRatio(n: number, numerator: number, denominator: number): number {
  requireThat(
    [n, numerator, denominator].every(Number.isSafeInteger) && n >= 0 && numerator >= 0 && denominator > 0,
    'Invalid accounting calculation.',
  );
  const result = (BigInt(n) * BigInt(numerator) + BigInt(Math.floor(denominator / 2))) / BigInt(denominator);
  requireThat(result <= BigInt(Number.MAX_SAFE_INTEGER), 'Amount exceeds supported limits.');
  return Number(result);
}
export function total(values: number[]) {
  const result = values.reduce((s, n) => s + n, 0);
  requireThat(
    Number.isSafeInteger(result) && Math.abs(result) <= 1_000_000_000_000,
    'Total exceeds supported limits.',
  );
  return result;
}
export function safeSum(values: number[]): number {
  let result = 0n;
  for (const value of values) {
    requireThat(Number.isSafeInteger(value), 'A reporting amount is outside exact integer limits.', 413);
    result += BigInt(value);
  }
  requireThat(
    result <= BigInt(Number.MAX_SAFE_INTEGER) && result >= BigInt(Number.MIN_SAFE_INTEGER),
    'Reporting total exceeds exact supported limits; narrow the date range.',
    413,
  );
  return Number(result);
}
export const reasonInput = z
  .string()
  .trim()
  .min(5, 'Please provide a reason of at least 5 characters.')
  .max(2000);
export const dateInput = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (d) => !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d && d <= kenyaDate(),
    'Enter a valid date, not in the future.',
  );
export const methods = ['Cash', 'M-Pesa', 'Card', 'Bank'] as const;
export const methodInput = z.enum(methods);
export const quantityInput = z.number().int().positive().max(100_000);
export function audit(
  db: DB,
  a: Actor,
  action: string,
  entity: string,
  entityId: string,
  before: unknown,
  after: unknown,
  reason: string,
  approvalId: string | null = null,
) {
  const previous = one(db, 'SELECT hash FROM audit_logs ORDER BY seq DESC LIMIT 1');
  const entry = {
    id: id('aud_'),
    ...scope(a),
    user_id: a.id,
    role: a.role_id,
    action,
    entity,
    entity_id: entityId,
    before_json: JSON.stringify(before ?? null),
    after_json: JSON.stringify(after ?? null),
    reason,
    approval_id: approvalId,
    ip: a.ip ?? '',
    device: (a.device ?? '').slice(0, 300),
    created_at: now(),
    previous_hash: previous?.hash ?? 'GENESIS',
  };
  insert(db, 'audit_logs', { ...entry, hash: sha(JSON.stringify(entry)) });
}
export function verifyAudit(db: DB, context?: Pick<Actor, 'business_id' | 'branch_id'>) {
  let previous = 'GENESIS';
  const errors: string[] = [];
  for (const row of all(db, 'SELECT * FROM audit_logs ORDER BY seq')) {
    const { seq, hash, ...entry } = row;
    if (
      (!context || (row.business_id === context.business_id && row.branch_id === context.branch_id)) &&
      (entry.previous_hash !== previous || sha(JSON.stringify(entry)) !== hash)
    )
      errors.push(`Audit chain mismatch at ${seq}`);
    previous = hash;
  }
  return errors;
}
export function journal(
  db: DB,
  a: Actor,
  reference: string,
  description: string,
  lines: { account: string; debit?: number; credit?: number }[],
  approvalId: string | null = null,
) {
  const active = lines.filter((l) => l.debit || l.credit);
  requireThat(
    total(active.map((l) => l.debit ?? 0)) === total(active.map((l) => l.credit ?? 0)),
    'Unbalanced journal entry.',
    500,
  );
  if (!active.length) return;
  const entryId = id('je_');
  insert(db, 'journal_entries', {
    id: entryId,
    ...scope(a),
    user_id: a.id,
    reference,
    description,
    approval_id: approvalId,
    created_at: now(),
  });
  for (const line of active)
    insert(db, 'journal_lines', {
      id: id('jl_'),
      entry_id: entryId,
      ...scope(a),
      account: line.account,
      debit_cents: line.debit ?? 0,
      credit_cents: line.credit ?? 0,
    });
}
export const paymentAccount = (method: string) =>
  ({ Cash: 'Cash on hand', 'M-Pesa': 'M-Pesa clearing', Card: 'Card clearing', Bank: 'Bank' })[method] ??
  'Accounts payable';
/** Read one consistent snapshot. HTTP callers receive only their own business/branch facts. */
export function integrity(db: DB, context?: Pick<Actor, 'business_id' | 'branch_id'>) {
  return db
    .transaction(() => {
      const args = context ? [context.business_id, context.branch_id] : [];
      const clause = (alias: string) =>
        context ? ` WHERE ${alias}.business_id=? AND ${alias}.branch_id=?` : '';
      const scopedRows = (table: string) => all(db, `SELECT t.* FROM ${table} t${clause('t')}`, ...args);
      const errors = verifyAudit(db, context);
      const error = (message: string) => {
        if (!errors.includes(message)) errors.push(message);
      };
      if ((db.pragma('integrity_check') as Row[]).some((r) => r.integrity_check !== 'ok'))
        error('Physical database integrity check failed');
      if (all(db, 'PRAGMA foreign_key_check').length)
        error('A database foreign-key constraint failed; contact the database operator');
      if (
        all(
          db,
          `SELECT l.entry_id FROM journal_lines l${clause('l')} GROUP BY l.entry_id HAVING SUM(l.debit_cents)<>SUM(l.credit_cents)`,
          ...args,
        ).length
      )
        error('Unbalanced journals');
      if (
        all(
          db,
          `SELECT e.id FROM journal_entries e${clause('e')}${context ? ' AND' : ' WHERE'} NOT EXISTS(SELECT 1 FROM journal_lines l WHERE l.entry_id=e.id)`,
          ...args,
        ).length
      )
        error('Empty journal entry');
      const actual = new Map<string, number>(),
        expected = new Map<string, number>();
      const key = (row: Row, account: string) => JSON.stringify([row.business_id, row.branch_id, account]);
      const add = (row: Row, account: string, value: number) =>
        expected.set(key(row, account), (expected.get(key(row, account)) ?? 0) + value);
      for (const row of all(
        db,
        `SELECT l.business_id,l.branch_id,l.account,SUM(l.debit_cents-l.credit_cents) value FROM journal_lines l${clause('l')} GROUP BY l.business_id,l.branch_id,l.account`,
        ...args,
      ))
        actual.set(key(row, row.account), row.value);
      for (const row of all(
        db,
        `SELECT i.*,COALESCE(SUM(m.quantity),0) ledger_qty,COALESCE(SUM(m.value_delta_cents),0) ledger_value,COUNT(m.id) movements FROM inventory i LEFT JOIN inventory_movements m ON m.product_id=i.product_id AND m.branch_id=i.branch_id AND m.business_id=i.business_id${clause('i')} GROUP BY i.business_id,i.branch_id,i.product_id`,
        ...args,
      )) {
        if (
          row.quantity !== row.ledger_qty ||
          row.value_cents !== row.ledger_value ||
          row.version !== row.movements
        )
          error('Inventory balance/version does not match its movement ledger');
        add(row, 'Inventory', row.value_cents);
      }
      const sales = scopedRows('sales'),
        expenses = scopedRows('expenses'),
        purchases = scopedRows('purchases');
      for (const sale of sales) {
        const lines = all(db, 'SELECT * FROM sale_items WHERE sale_id=?', sale.id);
        for (const field of ['subtotal_cents', 'discount_cents', 'total_cents', 'tax_cents', 'cogs_cents'])
          if (lines.reduce((sum, r) => sum + r[field], 0) !== sale[field])
            error('Sale header does not match recorded sale items');
        for (const line of lines) {
          try {
            const base = line.unit_price_cents * line.quantity;
            const charged =
              base + (line.tax_mode === 'exclusive' ? roundRatio(base, line.tax_bps, 10000) : 0);
            const tax = ['inclusive', 'exclusive'].includes(line.tax_mode)
              ? roundRatio(line.total_cents, line.tax_bps, 10000 + line.tax_bps)
              : 0;
            if (
              charged !== line.subtotal_cents ||
              line.total_cents !== line.subtotal_cents - line.discount_cents ||
              line.tax_cents !== tax
            )
              error('Sale item price/tax snapshot arithmetic mismatch');
          } catch {
            error('Invalid sale item monetary snapshot');
          }
          const returned = one(
            db,
            'SELECT COALESCE(SUM(quantity),0) qty,COALESCE(SUM(total_cents),0) gross,COALESCE(SUM(tax_cents),0) tax,COALESCE(SUM(cogs_cents),0) cogs FROM sale_return_items WHERE sale_item_id=?',
            line.id,
          )!;
          if (
            returned.qty > line.quantity ||
            returned.gross > line.total_cents ||
            returned.tax > line.tax_cents ||
            returned.cogs > line.cogs_cents
          )
            error('Sale return exceeds its original quantity or monetary allocation');
        }
        const tenders = one(
          db,
          'SELECT COALESCE(SUM(CASE WHEN reversal_id IS NULL THEN amount_cents ELSE 0 END),0) original,COALESCE(SUM(amount_cents),0) net FROM payments WHERE sale_id=?',
          sale.id,
        )!;
        const returned = one(
          db,
          'SELECT COALESCE(SUM(total_cents),0) n FROM sale_reversals WHERE sale_id=?',
          sale.id,
        )!.n;
        if (tenders.original !== sale.total_cents || tenders.net !== sale.total_cents - returned)
          error('Sale tenders do not reconcile to sale and returns');
        add(sale, 'Sales revenue', -(sale.total_cents - sale.tax_cents));
        add(sale, 'Output VAT', -sale.tax_cents);
        add(sale, 'Cost of goods sold', sale.cogs_cents);
      }
      for (const reversal of scopedRows('sale_reversals')) {
        const lines = all(db, 'SELECT * FROM sale_return_items WHERE reversal_id=?', reversal.id);
        for (const field of ['total_cents', 'tax_cents', 'cogs_cents'])
          if (lines.reduce((sum, r) => sum + r[field], 0) !== reversal[field])
            error('Return header does not match its item allocations');
        if (
          one(db, 'SELECT COALESCE(SUM(amount_cents),0) n FROM payments WHERE reversal_id=?', reversal.id)!
            .n !== -reversal.total_cents
        )
          error('Return does not reconcile to refund tenders');
        add(reversal, 'Sales revenue', reversal.total_cents - reversal.tax_cents);
        add(reversal, 'Output VAT', reversal.tax_cents);
        add(reversal, 'Cost of goods sold', -reversal.cogs_cents);
      }
      for (const p of scopedRows('payments')) {
        if (!p.reversal_id && p.tendered_cents - p.change_cents !== p.amount_cents)
          error('Tendered cash/change does not match payment');
        add(p, paymentAccount(p.method), p.amount_cents);
      }
      for (const e of expenses) {
        add(e, `Expense: ${e.category}`, e.amount_cents - (e.input_tax_cents ?? 0));
        add(e, 'Input VAT', e.input_tax_cents ?? 0);
        add(e, paymentAccount(e.method), -e.amount_cents);
      }
      for (const e of scopedRows('expense_reversals')) {
        const original = one(db, 'SELECT * FROM expenses WHERE id=?', e.expense_id);
        if (!original || e.amount_cents !== original.amount_cents)
          error('Expense reversal differs from original');
        if (original) {
          add(e, `Expense: ${original.category}`, -(e.amount_cents - (original.input_tax_cents ?? 0)));
          add(e, 'Input VAT', -(original.input_tax_cents ?? 0));
        }
        add(e, paymentAccount(e.method), e.amount_cents);
      }
      for (const p of purchases) {
        const lines = all(db, 'SELECT * FROM purchase_items WHERE purchase_id=?', p.id);
        if (
          lines.reduce((sum, r) => sum + r.total_cents, 0) + (p.input_tax_cents ?? 0) !== p.total_cents ||
          lines.some((r) => r.total_cents !== r.quantity * r.cost_cents)
        )
          error('Purchase header/items do not reconcile');
        if (one(db, 'SELECT id FROM purchase_receipts WHERE purchase_id=?', p.id)) {
          add(p, 'Accounts payable', -p.total_cents);
          add(p, 'Input VAT', p.input_tax_cents ?? 0);
        }
      }
      for (const p of scopedRows('purchase_reversals')) {
        add(p, 'Accounts payable', p.total_cents);
        const original = one(db, 'SELECT * FROM purchases WHERE id=?', p.purchase_id);
        add(p, 'Input VAT', -(original?.input_tax_cents ?? 0));
      }
      for (const p of scopedRows('supplier_payments')) {
        add(p, 'Accounts payable', p.amount_cents);
        add(p, paymentAccount(p.method), -p.amount_cents);
      }
      for (const table of ['supplier_refunds', 'supplier_payment_reversals'])
        for (const p of scopedRows(table)) {
          add(p, 'Accounts payable', -p.amount_cents);
          add(p, paymentAccount(p.method), p.amount_cents);
        }
      for (const r of scopedRows('reconciliations')) {
        const last = one(
          db,
          'SELECT variance_cents FROM reconciliation_adjustments WHERE reconciliation_id=? ORDER BY rowid DESC LIMIT 1',
          r.id,
        );
        const review = one(
          db,
          "SELECT status FROM approval_requests WHERE entity_id=? AND kind='daily_closing'",
          r.id,
        );
        const variance = last?.variance_cents ?? (review?.status === 'approved' ? r.variance_cents : 0);
        add(r, 'Cash on hand', variance);
        add(r, 'Cash over / short', -variance);
        if (
          r.expected_cents !==
            r.opening_cents + r.cash_sales_cents - r.cash_expenses_cents - r.cash_supplier_cents ||
          r.variance_cents !== r.actual_cents - r.expected_cents
        )
          error('Closing snapshot arithmetic mismatch');
      }
      // Opening floats are drawer counts, not new cash injections. These checks reconcile recorded operating flows.
      const checked = (account: string) =>
        [
          'Inventory',
          'Sales revenue',
          'Output VAT',
          'Input VAT',
          'Cost of goods sold',
          'Accounts payable',
          'Cash on hand',
          'M-Pesa clearing',
          'Card clearing',
          'Bank',
          'Cash over / short',
        ].includes(account) || account.startsWith('Expense: ');
      for (const bucket of new Set([...actual.keys(), ...expected.keys()])) {
        const account = JSON.parse(bucket)[2];
        if (checked(account) && (actual.get(bucket) ?? 0) !== (expected.get(bucket) ?? 0))
          error(`${account} does not reconcile to source records in its business/branch`);
      }
      for (const r of scopedRows('approval_requests'))
        if (['approved', 'rejected', 'clarification'].includes(r.status)) {
          if (
            !r.reviewer_id ||
            r.reviewer_id === r.user_id ||
            !r.reviewed_at ||
            !r.review_reason ||
            !one(
              db,
              'SELECT id FROM approval_events WHERE request_id=? AND action=? AND user_id=?',
              r.id,
              r.status,
              r.reviewer_id,
            )
          )
            error('Decision lacks independent reviewer metadata/history');
        }
      const auditEvents = one(db, `SELECT COUNT(*) n FROM audit_logs l${clause('l')}`, ...args)!.n;
      return {
        ok: errors.length === 0,
        errors,
        auditEvents,
        checkedAt: now(),
        scope: context ? 'business_branch' : 'database',
      };
    })
    .deferred();
}
