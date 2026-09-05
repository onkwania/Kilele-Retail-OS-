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
    age_confirmed: z.boolean().default(false),
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
      unit: p.unit,
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
    !q.items.some((i) => ['Spirits', 'Wines', 'Beer & Cider'].includes(i.category_name)) || b.age_confirmed,
    'Confirm the adult age check before selling alcohol.',
  );
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
  const business = one(
    db,
    'SELECT name,address,phone,tax_pin,receipt_footer,currency,timezone FROM businesses WHERE id=?',
    a.business_id,
  )!;
  const branch = one(
    db,
    'SELECT name,location FROM branches WHERE id=? AND business_id=?',
    a.branch_id,
    a.business_id,
  )!;
  const receiptSnapshot = { business, branch, register: session.register, staff_name: a.name };
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
    receipt_snapshot_json: JSON.stringify(receiptSnapshot),
    age_confirmed: b.age_confirmed ? 1 : 0,
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
export function renderReceipt(
  res: Response,
  currentBusiness: Row,
  details: ReturnType<typeof saleDetail>,
  layout: '80mm' | '58mm' | 'a4' = '80mm',
  currentBranch: Row = {},
) {
  const { sale, items, payments, reversals } = details;
  const snapshot = sale.receipt_snapshot_json ? JSON.parse(sale.receipt_snapshot_json) : null;
  const business = snapshot?.business ?? currentBusiness,
    branch = snapshot?.branch ?? currentBranch;
  const width = layout === 'a4' ? 595.28 : layout === '58mm' ? 164.41 : 226.77,
    margin = layout === 'a4' ? 36 : 14;
  const font = layout === '58mm' ? 8 : 9;
  type Block = { text: string; size?: number; bold?: boolean; center?: boolean; gap?: number };
  const blocks: Block[] = [
    { text: business.name, size: layout === '58mm' ? 14 : 18, bold: true, center: true, gap: 5 },
    { text: business.address || 'Business address not configured', center: true },
    ...(business.phone ? [{ text: business.phone, center: true }] : []),
    {
      text: `Branch: ${branch.name || 'Not recorded'}${branch.location ? ' · ' + branch.location : ''}`,
      center: true,
    },
    { text: `KRA PIN: ${business.tax_pin || 'Not configured'}`, center: true, gap: 9 },
    { text: 'INTERNAL SALES RECEIPT', bold: true, center: true },
    { text: sale.ref, bold: true, center: true, gap: 7 },
    { text: new Date(sale.created_at).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' }) + ' EAT' },
    { text: `Register: ${snapshot?.register ?? 'Not recorded'}` },
    { text: `Served by: ${snapshot?.staff_name ?? sale.staff_name}`, gap: 8 },
    ...(!snapshot
      ? [
          {
            text: 'Historical merchant identity was not captured. Current profile is shown; original sale amounts are preserved.',
            size: 7,
            gap: 7,
          },
        ]
      : []),
  ];
  for (const line of items) {
    blocks.push({ text: `${line.product_name} · ${line.size}`, bold: true });
    blocks.push({
      text: `${line.quantity} ${line.unit || 'unit'}${line.quantity === 1 ? '' : 's'} at KES ${amount(line.unit_price_cents)}${line.tax_mode === 'exclusive' ? ' (before tax)' : ''}`,
    });
    if (line.discount_cents) blocks.push({ text: `Line discount: KES ${amount(line.discount_cents)}` });
    blocks.push({
      text: `Line total: KES ${amount(line.total_cents)}${line.tax_cents ? ' · Tax KES ' + amount(line.tax_cents) : ''}`,
      gap: 6,
    });
  }
  blocks.push({ text: `Subtotal: KES ${amount(sale.subtotal_cents)}`, gap: 2 });
  if (sale.discount_cents) blocks.push({ text: `Discount: KES ${amount(sale.discount_cents)}` });
  blocks.push(
    { text: `Tax included: KES ${amount(sale.tax_cents)}` },
    { text: `TOTAL KES ${amount(sale.total_cents)}`, bold: true, size: 12, gap: 8 },
  );
  for (const payment of payments)
    blocks.push({
      text: `${payment.reversal_id ? 'Refund · ' : ''}${payment.method}: KES ${amount(payment.amount_cents)}${payment.reference ? ' · ' + payment.reference : ''}${payment.change_cents ? ' · Change KES ' + amount(payment.change_cents) : ''}`,
      gap: 3,
    });
  if (reversals.length)
    blocks.push({ text: `Linked return(s): ${reversals.map((r) => r.ref).join(', ')}`, gap: 5 });
  if (sale.notes) blocks.push({ text: sale.notes, size: 7, gap: 4 });
  blocks.push(
    { text: business.receipt_footer, center: true, gap: 7 },
    {
      text: 'This is an internal sales receipt, not an eTIMS fiscal invoice. Alcohol sales require the applicable adult-age checks.',
      size: 7,
      center: true,
    },
  );
  const measure = new PDFDocument({ autoFirstPage: false });
  const height = blocks.reduce(
    (sum, b) =>
      sum +
      measure
        .font(b.bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(b.size ?? font)
        .heightOfString(b.text, { width: width - margin * 2 }) +
      (b.gap ?? 2),
    margin * 2 + 12,
  );
  measure.end();
  measure.resume();
  const doc = new PDFDocument({
    size: layout === 'a4' ? 'A4' : [width, Math.min(14000, Math.max(240, Math.ceil(height)))],
    margin,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="receipt-${sale.ref}-${layout}.pdf"`);
  doc.pipe(res);
  for (const block of blocks) {
    doc
      .font(block.bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(block.size ?? font)
      .fillColor('#263b2d')
      .text(block.text, { align: block.center ? 'center' : 'left', width: width - margin * 2 });
    doc.y += block.gap ?? 2;
  }
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
      (SELECT COALESCE(SUM(total_cents),0) FROM sale_reversals WHERE sale_id=s.id) refunded_cents,(SELECT COUNT(*) FROM sale_items WHERE sale_id=s.id) item_count,(SELECT SUM(quantity) FROM sale_items WHERE sale_id=s.id) sold_quantity,(SELECT COALESCE(SUM(ri.quantity),0) FROM sale_return_items ri JOIN sale_items si ON si.id=ri.sale_item_id WHERE si.sale_id=s.id) returned_quantity
      FROM sales s JOIN users u ON u.id=s.user_id WHERE s.business_id=? AND s.branch_id=? ${a.role_id === 'cashier' ? 'AND s.user_id=?' : ''} ORDER BY s.created_at DESC LIMIT 2000`,
      a.business_id,
      a.branch_id,
      ...(a.role_id === 'cashier' ? [a.id] : []),
    );
    for (const row of rows) {
      row.return_status =
        row.returned_quantity >= row.sold_quantity
          ? 'fully_returned'
          : row.returned_quantity > 0
            ? 'part_returned'
            : 'completed';
      if (a.role_id === 'cashier') delete row.cogs_cents;
    }
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
    const layout = z.enum(['80mm', '58mm', 'a4']).parse(req.query.layout ?? '80mm');
    const details = saleDetail(db, req.actor, String(req.params.id));
    audit(db, req.actor, 'receipt.downloaded', 'sales', details.sale.id, null, null, 'Sales receipt PDF');
    renderReceipt(
      res,
      one(db, 'SELECT * FROM businesses WHERE id=?', req.actor.business_id)!,
      details,
      layout,
      one(
        db,
        'SELECT name,location FROM branches WHERE id=? AND business_id=?',
        req.actor.branch_id,
        req.actor.business_id,
      )!,
    );
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
