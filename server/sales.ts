import type { Express, Response } from 'express';
import PDFDocument from 'pdfkit';
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
  methodInput,
  quantityInput,
  total,
  demand,
  journal,
  paymentAccount,
  amount,
  kenyaDate,
} from './core.js';
import { protect } from './auth.js';
import { mutate } from './mutate.js';
import { costOf, inventoryFor, moveStock, ownSession } from './stock-engine.js';
const itemSchema = z
  .object({
    product_id: z.string(),
    quantity: quantityInput,
    price_type: z.enum(['retail', 'promo', 'wholesale']).default('retail'),
    version: z.number().int().positive(),
  })
  .strict();
export const quoteSchema = z
  .object({
    items: z.array(itemSchema).min(1).max(100),
    discount: moneyInput.default('0'),
    discount_reason: z.string().trim().max(1000).default(''),
  })
  .strict();
const saleSchema = quoteSchema
  .extend({
    session_id: z.string(),
    expected_total: moneyInput,
    customer_id: z.string().nullable().optional(),
    notes: z.string().max(1000).default(''),
    payments: z
      .array(
        z
          .object({
            method: methodInput,
            amount: moneyInput,
            tendered: moneyInput.optional(),
            reference: z.string().trim().max(100).default(''),
          })
          .strict(),
      )
      .min(1)
      .max(4),
  })
  .strict();
export function quoteSale(db: DB, a: Actor, input: z.infer<typeof quoteSchema>) {
  demand(a, 'sales.create');
  const body = quoteSchema.parse(input);
  requireThat(
    new Set(body.items.map((i) => i.product_id)).size === body.items.length,
    'Combine quantities for duplicate products.',
  );
  const lines: Row[] = body.items.map((item) => {
    const p = scoped(db, 'products', item.product_id, a, false);
    requireThat(p.active, `${p.name} is inactive.`);
    requireThat(
      p.version === item.version,
      `${p.name} has changed. Reload the catalogue before checkout.`,
      409,
    );
    requireThat(
      p.size && p.cost_cents !== null && p.selling_cents !== null,
      `Set the cost, selling price and package size for ${p.name} first.`,
    );
    requireThat(p.tax_mode !== 'unset', `Confirm tax configuration for ${p.name} before selling.`);
    if (item.price_type === 'wholesale') demand(a, 'sales.discount');
    const unitPrice =
      item.price_type === 'promo'
        ? p.promo_cents
        : item.price_type === 'wholesale'
          ? p.wholesale_cents
          : p.selling_cents;
    requireThat(unitPrice !== null && unitPrice > 0, `${item.price_type} price is not set for ${p.name}.`);
    const stock = inventoryFor(db, a, p.id);
    requireThat(
      stock.quantity >= item.quantity,
      `${p.name}: only ${stock.quantity} units are in stock.`,
      409,
    );
    const base = total([unitPrice * item.quantity]);
    const gross = base + (p.tax_mode === 'exclusive' ? roundRatio(base, p.tax_bps, 10000) : 0);
    return {
      product_id: p.id,
      product_name: p.name,
      sku: p.sku,
      size: p.size,
      quantity: item.quantity,
      unit_price_cents: unitPrice,
      unit_cost_cents: roundRatio(stock.value_cents, 1, stock.quantity),
      price_type: item.price_type,
      subtotal_cents: gross,
      tax_bps: p.tax_bps,
      tax_mode: p.tax_mode,
      cogs_cents: costOf(stock, item.quantity),
      category_name: one(db, 'SELECT name FROM categories WHERE id=?', p.category_id)!.name,
      brand_name: one(db, 'SELECT name FROM brands WHERE id=?', p.brand_id)!.name,
      supplier_name: p.supplier_id
        ? one(db, 'SELECT name FROM suppliers WHERE id=?', p.supplier_id)!.name
        : '',
    };
  });
  const subtotal = total(lines.map((l) => l.subtotal_cents)),
    discount = cents(body.discount);
  requireThat(discount < subtotal, 'Discount must be smaller than the sale total.');
  if (discount > 0) {
    demand(a, 'sales.discount');
    requireThat(body.discount_reason.length >= 5, 'Provide a reason for the authorised discount.');
  }
  let cumulative = 0,
    previousDiscount = 0;
  for (const line of lines) {
    cumulative += line.subtotal_cents;
    const cumulativeDiscount = roundRatio(discount, cumulative, subtotal);
    line.discount_cents = cumulativeDiscount - previousDiscount;
    previousDiscount = cumulativeDiscount;
    line.total_cents = line.subtotal_cents - line.discount_cents;
    requireThat(line.total_cents > 0, 'Discount is too large for one or more sale lines.');
    line.tax_cents = ['inclusive', 'exclusive'].includes(line.tax_mode)
      ? roundRatio(line.total_cents, line.tax_bps, 10000 + line.tax_bps)
      : 0;
  }
  return {
    items: lines,
    subtotal_cents: subtotal,
    discount_cents: discount,
    total_cents: subtotal - discount,
    tax_cents: total(lines.map((l) => l.tax_cents)),
    cogs_cents: total(lines.map((l) => l.cogs_cents)),
    discount_reason: body.discount_reason,
  };
}
export function createSale(db: DB, a: Actor, input: unknown) {
  const b = saleSchema.parse(input);
  const session = ownSession(db, a, b.session_id);
  if (b.customer_id) scoped(db, 'customers', b.customer_id, a, false);
  const q = quoteSale(db, a, { items: b.items, discount: b.discount, discount_reason: b.discount_reason });
  requireThat(
    cents(b.expected_total) === q.total_cents,
    'The total has changed. Review the updated quote.',
    409,
  );
  requireThat(
    new Set(b.payments.map((p) => p.method)).size === b.payments.length,
    'Use one entry for each payment method.',
  );
  const payments = b.payments.map((p) => {
    const value = cents(p.amount);
    requireThat(value > 0, 'Each payment must be greater than zero.');
    const reference = p.reference.toUpperCase();
    requireThat(
      p.method === 'Cash' || /^[A-Z0-9][A-Z0-9 _/-]{2,99}$/.test(reference),
      `Enter a valid ${p.method} transaction reference.`,
    );
    const tendered = p.tendered ? cents(p.tendered) : value;
    requireThat(
      p.method === 'Cash' ? tendered >= value : tendered === value,
      'Tendered payment is invalid. Only cash can include change.',
    );
    return {
      method: p.method,
      amount_cents: value,
      tendered_cents: tendered,
      change_cents: tendered - value,
      reference,
    };
  });
  requireThat(
    total(payments.map((p) => p.amount_cents)) === q.total_cents,
    'Payments must exactly match the sale total.',
  );
  const saleId = id('sale_'),
    saleRef = ref('SL'),
    timestamp = now();
  insert(db, 'sales', {
    id: saleId,
    ref: saleRef,
    ...scope(a),
    user_id: a.id,
    session_id: session.id,
    customer_id: b.customer_id ?? null,
    subtotal_cents: q.subtotal_cents,
    discount_cents: q.discount_cents,
    total_cents: q.total_cents,
    tax_cents: q.tax_cents,
    cogs_cents: q.cogs_cents,
    discount_reason: q.discount_reason,
    notes: b.notes,
    created_at: timestamp,
  });
  for (const line of q.items) {
    insert(db, 'sale_items', { id: id('si_'), sale_id: saleId, ...scope(a), ...line });
    moveStock(db, a, {
      product_id: line.product_id,
      quantity: -line.quantity,
      value_delta_cents: -line.cogs_cents,
      kind: 'sale',
      reference: saleRef,
      reason: 'Completed retail sale',
      session_id: session.id,
    });
  }
  for (const p of payments)
    insert(db, 'payments', {
      id: id('pay_'),
      ...scope(a),
      sale_id: saleId,
      reversal_id: null,
      session_id: session.id,
      user_id: a.id,
      ...p,
      created_at: timestamp,
    });
  journal(db, a, saleRef, 'Retail sale', [
    ...payments.map((p) => ({ account: paymentAccount(p.method), debit: p.amount_cents })),
    { account: 'Sales revenue', credit: q.total_cents - q.tax_cents },
    { account: 'Output VAT', credit: q.tax_cents },
    { account: 'Cost of goods sold', debit: q.cogs_cents },
    { account: 'Inventory', credit: q.cogs_cents },
  ]);
  audit(
    db,
    a,
    'sale.completed',
    'sales',
    saleId,
    null,
    { reference: saleRef, ...q, payments },
    'Completed sale',
  );
  return {
    ok: true,
    id: saleId,
    ref: saleRef,
    total_cents: q.total_cents,
    change_cents: total(payments.map((p) => p.change_cents)),
  };
}
export function saleDetail(
  db: DB,
  a: Actor,
  saleId: string,
): { sale: Row; items: Row[]; payments: Row[]; reversals: Row[] } {
  const sale = scoped(db, 'sales', saleId, a);
  requireThat(a.role_id !== 'cashier' || sale.user_id === a.id, 'You may only view your own sales.', 403);
  const items = all(db, 'SELECT * FROM sale_items WHERE sale_id=?', saleId),
    payments = all(db, 'SELECT * FROM payments WHERE sale_id=? ORDER BY created_at', saleId);
  const reversals = all(
    db,
    'SELECT r.*,u.name user_name FROM sale_reversals r JOIN users u ON u.id=r.user_id WHERE r.sale_id=? ORDER BY r.created_at',
    saleId,
  );
  for (const item of items)
    item.returned_qty = one(
      db,
      'SELECT COALESCE(SUM(quantity),0) n FROM sale_return_items WHERE sale_item_id=?',
      item.id,
    )!.n;
  const staff = one(db, 'SELECT name FROM users WHERE id=?', sale.user_id)!.name;
  if (a.role_id === 'cashier') {
    delete sale.cogs_cents;
    for (const item of items) {
      delete item.unit_cost_cents;
      delete item.cogs_cents;
    }
    for (const r of reversals) delete r.cogs_cents;
  }
  return { sale: { ...sale, staff_name: staff }, items, payments, reversals };
}
export function renderReceipt(res: Response, business: Row, details: ReturnType<typeof saleDetail>) {
  const { sale, items, payments, reversals } = details;
  const doc = new PDFDocument({
    size: [260, Math.max(480, 360 + items.length * 43 + payments.length * 34)],
    margin: 20,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="receipt-${sale.ref}.pdf"`);
  doc.pipe(res);
  doc.fillColor('#245745').fontSize(22).font('Helvetica-Bold').text(business.name, { align: 'center' });
  doc
    .fillColor('#555555')
    .fontSize(9)
    .font('Helvetica')
    .text(business.address || 'Kenya', { align: 'center' });
  if (business.phone) doc.text(business.phone, { align: 'center' });
  doc
    .moveDown()
    .fillColor('#222222')
    .fontSize(11)
    .text('SALES RECEIPT', { align: 'center' })
    .fontSize(9)
    .text(sale.ref, { align: 'center' });
  doc
    .moveDown()
    .text(new Date(sale.created_at).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' }))
    .text(`Served by: ${sale.staff_name}`)
    .moveDown();
  for (const line of items) {
    doc
      .font('Helvetica-Bold')
      .text(`${line.product_name} · ${line.size}`)
      .font('Helvetica')
      .text(`${line.quantity} × KES ${amount(line.unit_price_cents)}     KES ${amount(line.total_cents)}`)
      .moveDown(0.4);
  }
  doc.moveDown().text(`Subtotal: KES ${amount(sale.subtotal_cents)}`);
  if (sale.discount_cents) doc.text(`Discount: KES ${amount(sale.discount_cents)}`);
  doc
    .text(`Tax included: KES ${amount(sale.tax_cents)}`)
    .font('Helvetica-Bold')
    .fontSize(14)
    .text(`TOTAL  KES ${amount(sale.total_cents)}`)
    .font('Helvetica')
    .fontSize(9)
    .moveDown();
  for (const p of payments)
    doc.text(
      `${p.reversal_id ? 'Refund · ' : ''}${p.method}: KES ${amount(p.amount_cents)}${p.reference ? ' · ' + p.reference : ''}${p.change_cents ? ' · Change KES ' + amount(p.change_cents) : ''}`,
    );
  if (reversals.length) doc.moveDown().text(`Linked return(s): ${reversals.map((r) => r.ref).join(', ')}`);
  doc
    .moveDown()
    .text(business.receipt_footer, { align: 'center' })
    .moveDown()
    .fontSize(7)
    .fillColor('#666666')
    .text(
      'This is an internal sales receipt, not an eTIMS fiscal invoice. Alcohol sales are restricted to adults aged 18 and over.',
      { align: 'center' },
    );
  doc.end();
}
export function installSales(app: Express, db: DB) {
  app.post('/api/sales/quote', protect('sales.create'), (req, res) => {
    const quote = quoteSale(db, req.actor, quoteSchema.parse(req.body));
    if (req.actor.role_id === 'cashier') {
      delete (quote as Row).cogs_cents;
      for (const item of quote.items) {
        delete item.unit_cost_cents;
        delete item.cogs_cents;
      }
    }
    res.json(quote);
  });
  app.post('/api/sales', protect('sales.create'), (req, res) =>
    res.status(201).json(mutate(db, req, () => createSale(db, req.actor, req.body))),
  );
  app.get('/api/sales', protect('sales.read'), (req, res) => {
    const a = req.actor;
    const rows = all(
      db,
      `SELECT s.*,u.name staff_name,(SELECT GROUP_CONCAT(DISTINCT method) FROM payments WHERE sale_id=s.id AND reversal_id IS NULL) payment_methods,
      (SELECT COALESCE(SUM(total_cents),0) FROM sale_reversals WHERE sale_id=s.id) refunded_cents,(SELECT COUNT(*) FROM sale_items WHERE sale_id=s.id) item_count
      FROM sales s JOIN users u ON u.id=s.user_id WHERE s.business_id=? AND s.branch_id=? ${a.role_id === 'cashier' ? 'AND s.user_id=?' : ''} ORDER BY s.created_at DESC LIMIT 2000`,
      a.business_id,
      a.branch_id,
      ...(a.role_id === 'cashier' ? [a.id] : []),
    );
    if (a.role_id === 'cashier') for (const row of rows) delete row.cogs_cents;
    const from = new Date(`${kenyaDate()}T00:00:00+03:00`).toISOString(),
      to = new Date(Date.parse(from) + 86400000).toISOString();
    const today = one(
      db,
      `SELECT COUNT(*) transactions,COALESCE(SUM(s.total_cents),0) original_cents FROM sales s WHERE s.business_id=? AND s.branch_id=? AND s.created_at>=? AND s.created_at<? ${a.role_id === 'cashier' ? 'AND s.user_id=?' : ''}`,
      a.business_id,
      a.branch_id,
      from,
      to,
      ...(a.role_id === 'cashier' ? [a.id] : []),
    )!;
    today.net_collections_cents = one(
      db,
      `SELECT COALESCE(SUM(p.amount_cents),0) value FROM payments p JOIN sales s ON s.id=p.sale_id WHERE p.business_id=? AND p.branch_id=? AND p.created_at>=? AND p.created_at<? ${a.role_id === 'cashier' ? 'AND s.user_id=?' : ''}`,
      a.business_id,
      a.branch_id,
      from,
      to,
      ...(a.role_id === 'cashier' ? [a.id] : []),
    )!.value;
    res.json({ sales: rows, today });
  });
  app.get('/api/sales/:id', protect('sales.read'), (req, res) =>
    res.json(saleDetail(db, req.actor, String(req.params.id))),
  );
  app.get('/api/sales/:id/receipt', protect('sales.read'), (req, res) => {
    const details = saleDetail(db, req.actor, String(req.params.id));
    audit(db, req.actor, 'receipt.downloaded', 'sales', details.sale.id, null, null, 'Sales receipt PDF');
    renderReceipt(res, one(db, 'SELECT * FROM businesses WHERE id=?', req.actor.business_id)!, details);
  });
  app.post('/api/sessions', protect('sessions.own'), (req, res) => {
    const b = z
      .object({ register: z.string().trim().min(1).max(40), opening: moneyInput })
      .strict()
      .parse(req.body);
    res.status(201).json(
      mutate(db, req, () => {
        const row = {
          id: id('session_'),
          ...scope(req.actor),
          user_id: req.actor.id,
          register: b.register,
          opening_cents: cents(b.opening),
          opened_at: now(),
        };
        insert(db, 'cash_sessions', row);
        audit(
          db,
          req.actor,
          'session.opened',
          'cash_sessions',
          row.id,
          null,
          row,
          'Opening cash float counted',
        );
        return { ok: true, session: row };
      }),
    );
  });
}
