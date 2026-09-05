import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';

export type DB = Database.Database;
export type Row = Record<string, any>;
export type Actor = { id: string; business_id: string; branch_id: string; name: string; email: string; role_id: string; permissions: string[]; ip?: string; device?: string; must_change_password?: number };
export class AppError extends Error {
  constructor(public status: number, message: string, public code = 'VALIDATION_ERROR') { super(message); }
}
export function requireThat(condition: unknown, message: string, status = 400): asserts condition {
  if (!condition) throw new AppError(status, message);
}
export const id = (prefix = '') => `${prefix}${randomUUID()}`;
export const now = () => new Date().toISOString();
export const kenyaDate = (date = new Date()) => new Date(date.getTime() + 3 * 3600_000).toISOString().slice(0, 10);
export const ref = (prefix: string) => `${prefix}-${kenyaDate().replaceAll('-', '')}-${randomUUID().slice(0, 8).toUpperCase()}`;
export const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const one = (db: DB, sql: string, ...args: any[]): Row | undefined => db.prepare(sql).get(...args) as Row | undefined;
export const all = (db: DB, sql: string, ...args: any[]): Row[] => db.prepare(sql).all(...args) as Row[];
export function insert(db: DB, table: string, row: Row) {
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(k => row[k] ?? null));
}
export const scope = (a: Actor) => ({ business_id: a.business_id, branch_id: a.branch_id });
export function scoped(db: DB, table: string, entityId: string, a: Actor, branch = true) {
  const row = one(db, `SELECT * FROM ${table} WHERE id=? AND business_id=?${branch ? ' AND branch_id=?' : ''}`, entityId, a.business_id, ...(branch ? [a.branch_id] : []));
  requireThat(row, 'Record not found in your workspace.', 404);
  return row;
}
export const can = (a: Actor, permission: string) => a.permissions.includes(permission);
export const demand = (a: Actor, permission: string) => requireThat(can(a, permission), 'You do not have permission for this action.', 403);
export const moneyInput = z.string().trim().regex(/^\d{1,9}(\.\d{1,2})?$/, 'Enter a positive KES amount with at most 2 decimal places.');
export function cents(input: string): number {
  const value = moneyInput.parse(input);
  const [whole, fraction = ''] = value.split('.');
  return Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')));
}
export const amount = (n: number) => `${n < 0 ? '-' : ''}${Math.floor(Math.abs(n) / 100)}.${String(Math.abs(n) % 100).padStart(2, '0')}`;
export function roundRatio(n: number, numerator: number, denominator: number): number {
  requireThat([n, numerator, denominator].every(Number.isSafeInteger) && n >= 0 && numerator >= 0 && denominator > 0, 'Invalid accounting calculation.');
  const result = (BigInt(n) * BigInt(numerator) + BigInt(Math.floor(denominator / 2))) / BigInt(denominator);
  requireThat(result <= BigInt(Number.MAX_SAFE_INTEGER), 'Amount exceeds supported limits.');
  return Number(result);
}
export function total(values: number[]) {
  const result = values.reduce((s, n) => s + n, 0);
  requireThat(Number.isSafeInteger(result) && Math.abs(result) <= 1_000_000_000_000, 'Total exceeds supported limits.');
  return result;
}
export const reasonInput = z.string().trim().min(5, 'Please provide a reason of at least 5 characters.').max(2000);
export const dateInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(d => !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().slice(0,10) === d && d <= kenyaDate(), 'Enter a valid date, not in the future.');
export const methods = ['Cash', 'M-Pesa', 'Card', 'Bank'] as const;
export const methodInput = z.enum(methods);
export const quantityInput = z.number().int().positive().max(100_000);
export function audit(db: DB, a: Actor, action: string, entity: string, entityId: string, before: unknown, after: unknown, reason: string, approvalId: string | null = null) {
  const previous = one(db, 'SELECT hash FROM audit_logs ORDER BY seq DESC LIMIT 1');
  const entry = { id: id('aud_'), ...scope(a), user_id: a.id, role: a.role_id, action, entity, entity_id: entityId,
    before_json: JSON.stringify(before ?? null), after_json: JSON.stringify(after ?? null), reason, approval_id: approvalId,
    ip: a.ip ?? '', device: (a.device ?? '').slice(0, 300), created_at: now(), previous_hash: previous?.hash ?? 'GENESIS' };
  insert(db, 'audit_logs', { ...entry, hash: sha(JSON.stringify(entry)) });
}
export function verifyAudit(db: DB) {
  let previous = 'GENESIS';
  const errors: string[] = [];
  for (const row of all(db, 'SELECT * FROM audit_logs ORDER BY seq')) {
    const { seq, hash, ...entry } = row;
    if (entry.previous_hash !== previous || sha(JSON.stringify(entry)) !== hash) errors.push(`Audit chain mismatch at ${seq}`);
    previous = hash;
  }
  return errors;
}
export function journal(db: DB, a: Actor, reference: string, description: string, lines: { account: string; debit?: number; credit?: number }[], approvalId: string | null = null) {
  const active = lines.filter(l => l.debit || l.credit);
  requireThat(total(active.map(l => l.debit ?? 0)) === total(active.map(l => l.credit ?? 0)), 'Unbalanced journal entry.', 500);
  if (!active.length) return;
  const entryId = id('je_');
  insert(db, 'journal_entries', { id: entryId, ...scope(a), user_id: a.id, reference, description, approval_id: approvalId, created_at: now() });
  for (const line of active) insert(db, 'journal_lines', { id: id('jl_'), entry_id: entryId, ...scope(a), account: line.account, debit_cents: line.debit ?? 0, credit_cents: line.credit ?? 0 });
}
export const paymentAccount = (method: string) => ({ Cash: 'Cash on hand', 'M-Pesa': 'M-Pesa clearing', Card: 'Card clearing', Bank: 'Bank' })[method] ?? 'Accounts payable';
export function integrity(db: DB) {
  const errors = verifyAudit(db);
  const check = db.pragma('integrity_check') as Row[];
  if (check.some(r => r.integrity_check !== 'ok')) errors.push('SQLite integrity check failed');
  if (all(db, 'PRAGMA foreign_key_check').length) errors.push('Foreign key violation');
  if (all(db, 'SELECT entry_id FROM journal_lines GROUP BY entry_id HAVING SUM(debit_cents)<>SUM(credit_cents)').length) errors.push('Unbalanced journals');
  for (const row of all(db, `SELECT i.*, COALESCE(SUM(m.quantity),0) ledger_qty, COALESCE(SUM(m.value_delta_cents),0) ledger_value FROM inventory i LEFT JOIN inventory_movements m ON m.product_id=i.product_id AND m.branch_id=i.branch_id AND m.business_id=i.business_id GROUP BY i.product_id,i.branch_id,i.business_id`)) {
    if (row.quantity !== row.ledger_qty || row.value_cents !== row.ledger_value) errors.push(`Inventory ledger mismatch: ${row.product_id}`);
  }
  const stockValue = one(db, 'SELECT COALESCE(SUM(value_cents),0) n FROM inventory')!.n;
  const inventoryGl = one(db, "SELECT COALESCE(SUM(debit_cents-credit_cents),0) n FROM journal_lines WHERE account='Inventory'")!.n;
  if (stockValue !== inventoryGl) errors.push('Inventory does not tie to the general ledger');
  return { ok: !errors.length, errors, auditEvents: one(db, 'SELECT COUNT(*) n FROM audit_logs')!.n, checkedAt: now() };
}
