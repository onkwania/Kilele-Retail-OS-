import type { Express } from 'express';
import { z } from 'zod';
import {
  type DB,
  type Actor,
  type Row,
  one,
  all,
  requireThat,
  insert,
  id,
  ref,
  scope,
  now,
  scoped,
  roundRatio,
  audit,
  cents,
  moneyInput,
  quantityInput,
  total,
  demand,
  journal,
  paymentAccount,
  reasonInput,
  can,
} from './core.js';
import { protect } from './auth.js';
import { mutate } from './mutate.js';
import { inventoryFor, moveStock, ownSession, costOf } from './stock-engine.js';
import { newRequest } from './request-engine.js';
import { applyPrices, priceSchema } from './products.js';
import { applyStockRequest, postPurchase, saveSupplier, supplierSchema, availableCash } from './inventory.js';
import { createExpense, expenseSchema } from './expenses.js';
import { saleDetail } from './sales.js';
export const REQUEST_KINDS = [
  'sale_void',
  'sale_return',
  'sale_correction',
  'expense_reversal',
  'expense_correction',
  'stock_reversal',
  'price_change',
  'supplier_change',
  'purchase_reversal',
  'supplier_payment_reversal',
  'closing_correction',
  'other',
] as const;
const requestSchema = z
  .object({
    kind: z.enum(REQUEST_KINDS),
    entity_id: z.string().default(''),
    reason: reasonInput,
    explanation: z.string().trim().min(5).max(2000),
    requested_change: z.string().trim().min(5).max(2000),
    evidence_id: z.string().nullable().default(null),
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
const returnItemsSchema = z
  .array(z.object({ sale_item_id: z.string(), quantity: quantityInput }).strict())
  .min(1)
  .max(100);
export function createCorrectionRequest(db: DB, a: Actor, input: unknown) {
  demand(a, 'requests.create');
  const b = requestSchema.parse(input);
  let entity: string,
    entityId = b.entity_id,
    payload: Row = {},
    original: unknown;
  if (['sale_void', 'sale_return', 'sale_correction'].includes(b.kind)) {
    demand(a, 'sales.read');
    const details = saleDetail(db, a, b.entity_id);
    entity = 'sales';
    original = details;
    const items =
      b.kind === 'sale_return'
        ? returnItemsSchema.parse(b.payload.items)
        : details.items
            .filter((i) => i.returned_qty < i.quantity)
            .map((i) => ({ sale_item_id: i.id, quantity: i.quantity - i.returned_qty }));
    requireThat(items.length > 0, 'This sale is already fully reversed.');
    requireThat(new Set(items.map((i) => i.sale_item_id)).size === items.length, 'Duplicate return line.');
    for (const item of items) {
      const line = details.items.find((i) => i.id === item.sale_item_id);
      requireThat(
        line && item.quantity <= line.quantity - line.returned_qty,
        'Return quantity exceeds the remaining sold quantity.',
      );
    }
    payload = { items };
  } else if (['expense_reversal', 'expense_correction'].includes(b.kind)) {
    demand(a, 'expenses.read');
    entity = 'expenses';
    original = scoped(db, entity, b.entity_id, a);
    requireThat(
      !one(db, 'SELECT id FROM expense_reversals WHERE expense_id=?', b.entity_id),
      'This expense has already been reversed.',
    );
    if (b.kind === 'expense_correction')
      payload = { replacement: expenseSchema.parse(b.payload.replacement) };
  } else if (b.kind === 'stock_reversal') {
    demand(a, 'inventory.request');
    entity = 'inventory_movements';
    const movement = scoped(db, entity, b.entity_id, a);
    original = movement;
    requireThat(
      ['opening', 'adjustment', 'count', 'wastage', 'damaged'].includes(movement.kind),
      'Use the linked sale or purchase correction workflow for this movement.',
    );
    requireThat(
      !one(
        db,
        "SELECT id FROM approval_requests WHERE entity_id=? AND kind='stock_reversal' AND status='approved'",
        movement.id,
      ),
      'This stock movement has already been reversed.',
    );
    const stock = inventoryFor(db, a, movement.product_id);
    payload = {
      product_id: movement.product_id,
      delta: -movement.quantity,
      value_delta_cents: -movement.value_delta_cents,
      expected_inventory_version: stock.version,
      counter_account: movement.kind === 'opening' ? 'Opening equity' : 'Inventory adjustments',
    };
  } else if (b.kind === 'price_change') {
    demand(a, 'inventory.request');
    entity = 'products';
    original = scoped(db, entity, b.entity_id, a, false);
    payload = { row: priceSchema.parse({ ...b.payload, product_id: b.entity_id }) };
  } else if (b.kind === 'supplier_change') {
    demand(a, 'suppliers.read');
    entity = 'suppliers';
    original = b.entity_id ? scoped(db, entity, b.entity_id, a, false) : null;
    const base = original
      ? Object.fromEntries(
          Object.keys(supplierSchema.shape)
            .filter((k) => k !== 'reason')
            .map((k) => [k, k === 'active' ? !!(original as Row).active : (original as Row)[k]]),
        )
      : {};
    payload = { supplier: supplierSchema.parse({ ...base, ...b.payload, reason: b.reason }) };
  } else if (b.kind === 'purchase_reversal') {
    demand(a, 'inventory.receive');
    entity = 'purchases';
    const p = scoped(db, entity, b.entity_id, a);
    requireThat(
      one(db, 'SELECT id FROM purchase_receipts WHERE purchase_id=?', p.id),
      'Only a received purchase can be reversed.',
    );
    requireThat(
      !one(db, 'SELECT id FROM purchase_reversals WHERE purchase_id=?', p.id),
      'Purchase is already reversed.',
    );
    original = { ...p, items: all(db, 'SELECT * FROM purchase_items WHERE purchase_id=?', p.id) };
  } else if (b.kind === 'supplier_payment_reversal') {
    demand(a, 'expenses.create');
    entity = 'supplier_payments';
    original = scoped(db, entity, b.entity_id, a);
    requireThat(
      !one(db, 'SELECT id FROM supplier_payment_reversals WHERE payment_id=?', b.entity_id),
      'Payment was already reversed.',
    );
  } else if (b.kind === 'closing_correction') {
    demand(a, 'sessions.own');
    entity = 'reconciliations';
    const closing = scoped(db, entity, b.entity_id, a);
    requireThat(
      closing.user_id === a.id || can(a, 'approvals.read'),
      'Only your own closing can be corrected.',
      403,
    );
    const last = one(
      db,
      'SELECT * FROM reconciliation_adjustments WHERE reconciliation_id=? ORDER BY rowid DESC LIMIT 1',
      closing.id,
    );
    original = { ...closing, latest_adjustment: last ?? null };
    payload = { actual: cents(moneyInput.parse(b.payload.actual)), previous_adjustment_id: last?.id ?? null };
  } else {
    entity = 'review_notes';
    entityId = id('note_');
    payload = { review_only: true };
    original = {
      notice: 'Human review note. No financial or stock changes are executed for this request type.',
    };
  }
  const r = newRequest(db, a, { ...b, entity, entity_id: entityId, payload, original });
  return { ok: true, id: r.id, ref: r.ref };
}
function reverseSale(db: DB, a: Actor, r: Row) {
  const original = scoped(db, 'sales', r.entity_id, a),
    session = ownSession(db, a),
    payload = JSON.parse(r.payload_json);
  const lines = returnItemsSchema.parse(payload.items).map((item) => {
    const line = one(db, 'SELECT * FROM sale_items WHERE id=? AND sale_id=?', item.sale_item_id, original.id);
    requireThat(line, 'Original sale item is missing.');
    const previous = one(
      db,
      'SELECT COALESCE(SUM(quantity),0) quantity,COALESCE(SUM(total_cents),0) total_cents,COALESCE(SUM(tax_cents),0) tax_cents,COALESCE(SUM(cogs_cents),0) cogs_cents FROM sale_return_items WHERE sale_item_id=?',
      line.id,
    )!;
    const cumulative = previous.quantity + item.quantity;
    requireThat(
      cumulative <= line.quantity,
      'Some of these units were already returned. Submit a new request.',
      409,
    );
    const cumulativeGross = roundRatio(line.total_cents, cumulative, line.quantity);
    const refundGross = cumulativeGross - previous.total_cents;
    const idealTax = roundRatio(line.tax_cents, cumulativeGross, line.total_cents);
    const minTax = Math.max(previous.tax_cents, line.tax_cents - (line.total_cents - cumulativeGross));
    const maxTax = Math.min(line.tax_cents, previous.tax_cents + refundGross);
    const cumulativeTax = Math.max(minTax, Math.min(maxTax, idealTax));
    return {
      sale_item_id: line.id,
      product_id: line.product_id,
      quantity: item.quantity,
      total_cents: refundGross,
      tax_cents: cumulativeTax - previous.tax_cents,
      cogs_cents: roundRatio(line.cogs_cents, cumulative, line.quantity) - previous.cogs_cents,
    };
  });
  const gross = total(lines.map((l) => l.total_cents)),
    tax = total(lines.map((l) => l.tax_cents)),
    cogs = total(lines.map((l) => l.cogs_cents));
  // Zero-cent allocations are still physical returns: restore stock/COGS, without a zero payment row.
  requireThat(gross >= 0 && tax <= gross, 'Invalid cumulative refund allocation.');
  const tenders = all(
      db,
      'SELECT method,SUM(amount_cents) balance FROM payments WHERE sale_id=? GROUP BY method HAVING SUM(amount_cents)>0 ORDER BY method',
      original.id,
    ),
    remaining = total(tenders.map((t) => t.balance));
  requireThat(gross <= remaining, 'Refund exceeds the sale balance.', 409);
  let cumulative = 0,
    distributed = 0;
  const refunds = tenders
    .map((t) => {
      cumulative += t.balance;
      const allocated = roundRatio(gross, cumulative, remaining) - distributed;
      distributed += allocated;
      return { method: t.method, amount_cents: allocated };
    })
    .filter((t) => t.amount_cents > 0);
  const cash = refunds.find((t) => t.method === 'Cash')?.amount_cents ?? 0;
  requireThat(
    availableCash(db, session.id) >= cash,
    'Open or fund an appropriate register before posting a cash refund.',
    409,
  );
  const reversal = {
    id: id('return_'),
    ref: ref('RT'),
    ...scope(a),
    sale_id: original.id,
    approval_id: r.id,
    user_id: a.id,
    session_id: session.id,
    total_cents: gross,
    tax_cents: tax,
    cogs_cents: cogs,
    reason: r.reason,
    created_at: now(),
  };
  insert(db, 'sale_reversals', reversal);
  for (const line of lines) {
    const { product_id, ...data } = line;
    insert(db, 'sale_return_items', { id: id(), reversal_id: reversal.id, ...data });
    moveStock(db, a, {
      product_id,
      quantity: line.quantity,
      value_delta_cents: line.cogs_cents,
      kind: 'return',
      reference: reversal.ref,
      reason: r.reason,
      approval_id: r.id,
      session_id: session.id,
    });
  }
  for (const p of refunds)
    insert(db, 'payments', {
      id: id('refund_'),
      ...scope(a),
      sale_id: original.id,
      reversal_id: reversal.id,
      session_id: session.id,
      user_id: a.id,
      method: p.method,
      amount_cents: -p.amount_cents,
      tendered_cents: 0,
      change_cents: 0,
      reference: reversal.ref,
      created_at: now(),
    });
  journal(
    db,
    a,
    reversal.ref,
    'Approved sale return/reversal',
    [
      { account: 'Sales revenue', debit: gross - tax },
      { account: 'Output VAT', debit: tax },
      ...refunds.map((p) => ({ account: paymentAccount(p.method), credit: p.amount_cents })),
      { account: 'Inventory', debit: cogs },
      { account: 'Cost of goods sold', credit: cogs },
    ],
    r.id,
  );
  audit(
    db,
    a,
    'sale.reversed',
    'sale_reversals',
    reversal.id,
    original,
    { ...reversal, lines, refunds },
    r.reason,
    r.id,
  );
}
function reverseExpense(db: DB, a: Actor, r: Row) {
  const e = scoped(db, 'expenses', r.entity_id, a);
  requireThat(
    !one(db, 'SELECT id FROM expense_reversals WHERE expense_id=?', e.id),
    'Expense was already reversed.',
    409,
  );
  const session = e.method === 'Cash' ? ownSession(db, a) : null;
  const row = {
    id: id('exrev_'),
    ref: ref('ER'),
    ...scope(a),
    expense_id: e.id,
    approval_id: r.id,
    user_id: a.id,
    session_id: session?.id ?? null,
    amount_cents: e.amount_cents,
    method: e.method,
    reason: r.reason,
    created_at: now(),
  };
  insert(db, 'expense_reversals', row);
  journal(
    db,
    a,
    row.ref,
    'Approved expense reversal',
    [
      { account: paymentAccount(e.method), debit: e.amount_cents },
      { account: `Expense: ${e.category}`, credit: e.amount_cents - (e.input_tax_cents ?? 0) },
      { account: 'Input VAT', credit: e.input_tax_cents ?? 0 },
    ],
    r.id,
  );
  audit(db, a, 'expense.reversed', 'expense_reversals', row.id, e, row, r.reason, r.id);
  if (r.kind === 'expense_correction')
    createExpense(db, a, JSON.parse(r.payload_json).replacement, r.id, e.id);
}
function reversePurchase(db: DB, a: Actor, r: Row) {
  const p = scoped(db, 'purchases', r.entity_id, a);
  requireThat(
    !one(db, 'SELECT id FROM purchase_reversals WHERE purchase_id=?', p.id),
    'Purchase already reversed.',
    409,
  );
  const lines: Row[] = all(db, 'SELECT * FROM purchase_items WHERE purchase_id=?', p.id).map((item) => ({
    ...item,
    removed_cents: costOf(inventoryFor(db, a, item.product_id), item.quantity),
  }));
  const removed = total(lines.map((l) => l.removed_cents));
  const paid = all(
    db,
    `SELECT sp.method,SUM(sp.amount_cents-COALESCE(spr.amount_cents,0)) amount_cents FROM supplier_payments sp LEFT JOIN supplier_payment_reversals spr ON spr.payment_id=sp.id WHERE sp.purchase_id=? GROUP BY sp.method HAVING SUM(sp.amount_cents-COALESCE(spr.amount_cents,0))>0`,
    p.id,
  );
  const paidTotal = total(paid.map((t) => t.amount_cents));
  const session = paid.some((t) => t.method === 'Cash') ? ownSession(db, a) : null;
  const row = {
    id: id('porev_'),
    ref: ref('PR'),
    ...scope(a),
    purchase_id: p.id,
    approval_id: r.id,
    user_id: a.id,
    total_cents: p.total_cents,
    inventory_cents: removed,
    reason: r.reason,
    created_at: now(),
  };
  insert(db, 'purchase_reversals', row);
  for (const item of lines)
    moveStock(db, a, {
      product_id: item.product_id,
      quantity: -item.quantity,
      value_delta_cents: -item.removed_cents,
      kind: 'purchase_return',
      reference: row.ref,
      reason: r.reason,
      approval_id: r.id,
    });
  for (const t of paid)
    insert(db, 'supplier_refunds', {
      id: id('sref_'),
      ...scope(a),
      purchase_id: p.id,
      reversal_id: row.id,
      user_id: a.id,
      session_id: t.method === 'Cash' ? session!.id : null,
      method: t.method,
      amount_cents: t.amount_cents,
      created_at: now(),
    });
  const difference = removed - (p.total_cents - (p.input_tax_cents ?? 0));
  journal(
    db,
    a,
    row.ref,
    'Approved supplier return',
    [
      { account: 'Accounts payable', debit: p.total_cents - paidTotal },
      ...paid.map((t) => ({ account: paymentAccount(t.method), debit: t.amount_cents })),
      { account: 'Inventory', credit: removed },
      { account: 'Input VAT', credit: p.input_tax_cents ?? 0 },
      ...(difference > 0
        ? [{ account: 'Inventory adjustments', debit: difference }]
        : [{ account: 'Inventory adjustments', credit: -difference }]),
    ],
    r.id,
  );
  audit(
    db,
    a,
    'purchase.reversed',
    'purchase_reversals',
    row.id,
    p,
    { ...row, lines, refunds: paid },
    r.reason,
    r.id,
  );
}
function reverseSupplierPayment(db: DB, a: Actor, r: Row) {
  const p = scoped(db, 'supplier_payments', r.entity_id, a);
  requireThat(
    !one(db, 'SELECT id FROM supplier_payment_reversals WHERE payment_id=?', p.id),
    'Payment was already reversed.',
    409,
  );
  requireThat(
    !one(db, 'SELECT id FROM purchase_reversals WHERE purchase_id=?', p.purchase_id),
    'The related purchase has already been reversed.',
    409,
  );
  const session = p.method === 'Cash' ? ownSession(db, a) : null;
  const row = {
    id: id('spr_'),
    ref: ref('SR'),
    ...scope(a),
    payment_id: p.id,
    purchase_id: p.purchase_id,
    approval_id: r.id,
    user_id: a.id,
    session_id: session?.id ?? null,
    method: p.method,
    amount_cents: p.amount_cents,
    reason: r.reason,
    created_at: now(),
  };
  insert(db, 'supplier_payment_reversals', row);
  journal(
    db,
    a,
    row.ref,
    'Supplier payment reversal',
    [
      { account: paymentAccount(p.method), debit: p.amount_cents },
      { account: 'Accounts payable', credit: p.amount_cents },
    ],
    r.id,
  );
  audit(db, a, 'supplier_payment.reversed', 'supplier_payment_reversals', row.id, p, row, r.reason, r.id);
}
function bookVariance(db: DB, a: Actor, reference: string, variance: number, approvalId: string) {
  journal(
    db,
    a,
    reference,
    'Approved cash variance',
    variance >= 0
      ? [
          { account: 'Cash on hand', debit: variance },
          { account: 'Cash over / short', credit: variance },
        ]
      : [
          { account: 'Cash over / short', debit: -variance },
          { account: 'Cash on hand', credit: -variance },
        ],
    approvalId,
  );
}
function correctClosing(db: DB, a: Actor, r: Row) {
  const closing = scoped(db, 'reconciliations', r.entity_id, a),
    payload = JSON.parse(r.payload_json);
  const review = one(
    db,
    "SELECT * FROM approval_requests WHERE entity_id=? AND kind='daily_closing' AND status IN('approved','rejected')",
    closing.id,
  );
  requireThat(review, 'Review the original daily closing before approving its correction.', 409);
  const last = one(
    db,
    'SELECT * FROM reconciliation_adjustments WHERE reconciliation_id=? ORDER BY rowid DESC LIMIT 1',
    closing.id,
  );
  requireThat(
    (last?.id ?? null) === payload.previous_adjustment_id,
    'Another closing correction was posted. Submit a fresh request.',
    409,
  );
  const priorVariance = last?.variance_cents ?? (review.status === 'approved' ? closing.variance_cents : 0),
    newVariance = payload.actual - closing.expected_cents;
  const row = {
    id: id('r adj_'.replace(' ', '')),
    ref: ref('CA'),
    ...scope(a),
    reconciliation_id: closing.id,
    approval_id: r.id,
    user_id: a.id,
    previous_actual_cents: last?.actual_cents ?? closing.actual_cents,
    actual_cents: payload.actual,
    previous_variance_cents: last?.variance_cents ?? closing.variance_cents,
    variance_cents: newVariance,
    reason: r.reason,
    created_at: now(),
  };
  insert(db, 'reconciliation_adjustments', row);
  bookVariance(db, a, row.ref, newVariance - priorVariance, r.id);
  audit(db, a, 'closing.corrected', 'reconciliation_adjustments', row.id, closing, row, r.reason, r.id);
}
export function reviewRequest(db: DB, a: Actor, requestId: string, input: unknown) {
  demand(a, 'approvals.review');
  const b = z
    .object({ action: z.enum(['approve', 'reject', 'clarify']), reason: reasonInput })
    .strict()
    .parse(input);
  const r = scoped(db, 'approval_requests', requestId, a);
  requireThat(r.user_id !== a.id, 'You cannot review or approve your own request.', 403);
  requireThat(r.status === 'pending', 'Only a pending request can be reviewed.', 409);
  if (b.action === 'approve') {
    if (['sale_void', 'sale_return', 'sale_correction'].includes(r.kind)) reverseSale(db, a, r);
    else if (['expense_reversal', 'expense_correction'].includes(r.kind)) reverseExpense(db, a, r);
    else if (r.kind === 'stock_receipt') postPurchase(db, a, r.entity_id, r.id);
    else if (['stock_count', 'stock_adjustment', 'wastage', 'damaged', 'stock_reversal'].includes(r.kind)) {
      if (r.kind === 'stock_reversal')
        requireThat(
          !one(
            db,
            "SELECT id FROM approval_requests WHERE entity_id=? AND kind='stock_reversal' AND status='approved'",
            r.entity_id,
          ),
          'Movement already reversed.',
          409,
        );
      applyStockRequest(db, a, r);
    } else if (r.kind === 'price_change')
      applyPrices(db, a, [JSON.parse(r.payload_json).row], b.reason, r.id);
    else if (r.kind === 'supplier_change') {
      if (r.entity_id) {
        const current = scoped(db, 'suppliers', r.entity_id, a, false);
        requireThat(
          JSON.stringify(current) === r.original_json,
          'Supplier changed after this request. Submit a new request.',
          409,
        );
      }
      saveSupplier(db, a, JSON.parse(r.payload_json).supplier, r.entity_id || undefined, r.id);
    } else if (r.kind === 'purchase_reversal') reversePurchase(db, a, r);
    else if (r.kind === 'supplier_payment_reversal') reverseSupplierPayment(db, a, r);
    else if (r.kind === 'daily_closing') {
      const closing = scoped(db, 'reconciliations', r.entity_id, a);
      bookVariance(db, a, closing.ref, closing.variance_cents, r.id);
      audit(
        db,
        a,
        'closing.approved',
        'reconciliations',
        closing.id,
        closing,
        { reviewed: true },
        b.reason,
        r.id,
      );
    } else if (r.kind === 'closing_correction') correctClosing(db, a, r);
    else
      requireThat(
        r.kind === 'other',
        'This request type cannot be automatically executed. Ask for clarification.',
        400,
      );
  }
  const status = b.action === 'approve' ? 'approved' : b.action === 'reject' ? 'rejected' : 'clarification';
  db.prepare(
    'UPDATE approval_requests SET status=?,reviewer_id=?,review_reason=?,reviewed_at=? WHERE id=?',
  ).run(status, a.id, b.reason, now(), r.id);
  insert(db, 'approval_events', {
    id: id(),
    request_id: r.id,
    user_id: a.id,
    action: status,
    reason: b.reason,
    created_at: now(),
  });
  audit(
    db,
    a,
    `approval.${status}`,
    'approval_requests',
    r.id,
    { status: r.status },
    { status, reviewer_id: a.id, review_reason: b.reason },
    b.reason,
    r.id,
  );
  return { ok: true, id: r.id, status };
}
export function installApprovals(app: Express, db: DB) {
  app.get('/api/approvals', protect(), (req, res) => {
    const a = req.actor;
    requireThat(can(a, 'approvals.read') || can(a, 'requests.create'), 'Permission denied.', 403);
    res.json({
      requests: all(
        db,
        `SELECT r.*,u.name requester_name,rv.name reviewer_name FROM approval_requests r JOIN users u ON u.id=r.user_id LEFT JOIN users rv ON rv.id=r.reviewer_id WHERE r.business_id=? AND r.branch_id=? ${can(a, 'approvals.read') ? '' : 'AND r.user_id=?'} ORDER BY r.created_at DESC LIMIT 2000`,
        a.business_id,
        a.branch_id,
        ...(can(a, 'approvals.read') ? [] : [a.id]),
      ),
    });
  });
  app.get('/api/approvals/:id', protect(), (req, res) => {
    const r = scoped(db, 'approval_requests', String(req.params.id), req.actor);
    requireThat(r.user_id === req.actor.id || can(req.actor, 'approvals.read'), 'Permission denied.', 403);
    res.json({
      request: r,
      events: all(
        db,
        'SELECT e.*,u.name user_name FROM approval_events e JOIN users u ON u.id=e.user_id WHERE e.request_id=? ORDER BY e.created_at',
        r.id,
      ),
    });
  });
  app.post('/api/approvals', protect('requests.create'), (req, res) =>
    res.status(201).json(mutate(db, req, () => createCorrectionRequest(db, req.actor, req.body))),
  );
  app.post('/api/approvals/:id/review', protect('approvals.review'), (req, res) =>
    res.json(mutate(db, req, () => reviewRequest(db, req.actor, String(req.params.id), req.body))),
  );
  app.post('/api/approvals/:id/reply', protect('requests.create'), (req, res) => {
    const b = z.object({ reason: reasonInput }).strict().parse(req.body);
    res.json(
      mutate(db, req, () => {
        const r = scoped(db, 'approval_requests', String(req.params.id), req.actor);
        requireThat(r.user_id === req.actor.id, 'Only the requester may respond.', 403);
        requireThat(r.status === 'clarification', 'This request is not awaiting clarification.', 409);
        db.prepare(
          "UPDATE approval_requests SET status='pending',reviewer_id=NULL,review_reason=NULL,reviewed_at=NULL WHERE id=?",
        ).run(r.id);
        insert(db, 'approval_events', {
          id: id(),
          request_id: r.id,
          user_id: req.actor.id,
          action: 'clarified',
          reason: b.reason,
          created_at: now(),
        });
        audit(
          db,
          req.actor,
          'approval.clarified',
          'approval_requests',
          r.id,
          { status: r.status },
          { status: 'pending', response: b.reason },
          b.reason,
          r.id,
        );
        return { ok: true, id: r.id };
      }),
    );
  });
  app.get('/api/audit', protect('audit.read'), (req, res) =>
    res.json({
      events: all(
        db,
        'SELECT l.*,u.name user_name FROM audit_logs l JOIN users u ON u.id=l.user_id WHERE l.business_id=? AND l.branch_id=? ORDER BY l.seq DESC LIMIT 1000',
        req.actor.business_id,
        req.actor.branch_id,
      ),
    }),
  );
}
