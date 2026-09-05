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
  audit,
  amount,
  can,
  demand,
  kenyaDate,
} from './core.js';
import { protect } from './auth.js';
import {
  bounds,
  readRange,
  saleEvents,
  expenseEvents,
  aggregate,
  staffPerformance,
  limited,
  type Range,
} from './analytics.js';
export type Column = { key: string; label: string; money?: boolean };
const col = (key: string, label: string, money = false): Column => ({ key, label, money });
export const REPORTS: Record<
  string,
  { name: string; description: string; permission: string; filters: string[]; columns: Column[] }
> = {
  sales: {
    name: 'Sales report',
    description:
      'Posted sales and returns, with original price snapshots. Mixed tenders never duplicate a sale line.',
    permission: 'reports.read',
    filters: ['staff', 'product', 'category', 'brand', 'supplier', 'payment'],
    columns: [
      col('date', 'Date'),
      col('transaction_ref', 'Transaction'),
      col('event_type', 'Type'),
      col('product_name', 'Product'),
      col('size', 'Size'),
      col('quantity', 'Qty'),
      col('unit_price_cents', 'Unit price', true),
      col('total_cents', 'Total KES', true),
      col('payment_method', 'Payment'),
      col('staff', 'Staff'),
    ],
  },
  profit: {
    name: 'Profit & margin',
    description:
      'Revenue excluding configured tax, less recorded weighted-average cost. Returns netted on their posting dates.',
    permission: 'reports.read',
    filters: ['staff', 'product', 'category', 'brand', 'supplier', 'payment'],
    columns: [
      col('product_name', 'Product'),
      col('quantity', 'Net qty'),
      col('revenue_cents', 'Revenue KES', true),
      col('cogs_cents', 'COGS KES', true),
      col('profit_cents', 'Gross profit KES', true),
      col('margin', 'Margin %'),
    ],
  },
  inventory: {
    name: 'Inventory valuation',
    description: 'Opening and closing balances reconstructed from the ledger, not today’s product cost.',
    permission: 'reports.inventory',
    filters: ['product', 'category', 'brand', 'supplier'],
    columns: [
      col('product_name', 'Product'),
      col('sku', 'SKU'),
      col('opening_stock', 'Opening'),
      col('purchases', 'Purchases'),
      col('sales', 'Sales'),
      col('returns', 'Returns'),
      col('damaged', 'Damaged'),
      col('wastage', 'Wastage'),
      col('adjustments', 'Adjustments'),
      col('closing_stock', 'Closing'),
      col('stock_value_cents', 'Value KES', true),
    ],
  },
  expenses: {
    name: 'Expense report',
    description: 'Posted expenses and approved reversals. Original receipt dates are retained separately.',
    permission: 'reports.read',
    filters: ['staff', 'category', 'supplier', 'payment'],
    columns: [
      col('date', 'Posting date'),
      col('expense_date', 'Receipt date'),
      col('ref', 'Reference'),
      col('category', 'Category'),
      col('supplier', 'Payee'),
      col('description', 'Description'),
      col('amount_cents', 'Amount KES', true),
      col('payment_method', 'Payment'),
      col('staff', 'Staff'),
    ],
  },
  purchases: {
    name: 'Supplier purchases',
    description: 'Received purchases and approved supplier returns. Unapproved deliveries are not inventory.',
    permission: 'reports.inventory',
    filters: ['staff', 'product', 'supplier', 'payment'],
    columns: [
      col('date', 'Date'),
      col('ref', 'Reference'),
      col('supplier', 'Supplier'),
      col('product_name', 'Product'),
      col('quantity', 'Qty'),
      col('cost_cents', 'Cost KES', true),
      col('total_cents', 'Total KES', true),
      col('payment_method', 'Payment'),
      col('staff', 'Entered by'),
    ],
  },
  staff: {
    name: 'Staff performance',
    description: 'Operational information for human review. Not an assessment of misconduct.',
    permission: 'staff.read',
    filters: ['staff'],
    columns: [
      col('staff', 'Staff'),
      col('transactions', 'Sales'),
      col('sales_cents', 'Sales KES', true),
      col('average_cents', 'Average KES', true),
      col('cash_cents', 'Cash KES', true),
      col('mpesa_cents', 'M-Pesa KES', true),
      col('card_cents', 'Card KES', true),
      col('discounts_cents', 'Discounts issued', true),
      col('correction_requests', 'Requests'),
      col('expenses_cents', 'Expenses KES', true),
      col('stock_entries', 'Stock entries'),
      col('reconciliation_status', 'Closing'),
    ],
  },
  approvals: {
    name: 'Approval register',
    description: 'Original requests, decisions, requesting users and reviewer reasons.',
    permission: 'approvals.read',
    filters: ['staff'],
    columns: [
      col('date', 'Date'),
      col('ref', 'Request'),
      col('kind', 'Type'),
      col('staff', 'Requested by'),
      col('status', 'Status'),
      col('reviewer', 'Reviewer'),
      col('reason', 'Request reason'),
      col('review_reason', 'Decision reason'),
    ],
  },
  audit: {
    name: 'Audit trail',
    description: 'Append-only audit events. CSV includes complete before/after states and chain hashes.',
    permission: 'audit.read',
    filters: ['staff'],
    columns: [
      col('date', 'Date / time'),
      col('staff', 'User'),
      col('role', 'Role'),
      col('action', 'Action'),
      col('entity', 'Entity'),
      col('entity_id', 'Entity ID'),
      col('reason', 'Reason'),
      col('before_json', 'Before state'),
      col('after_json', 'After state'),
      col('hash', 'SHA-256 hash'),
    ],
  },
  payments: {
    name: 'Payment reconciliation',
    description:
      'Exact sale tenders and refunds. Use this report for Cash, M-Pesa, Card and Bank settlement totals.',
    permission: 'reports.read',
    filters: ['staff', 'payment'],
    columns: [
      col('date', 'Date'),
      col('transaction_ref', 'Sale'),
      col('reference', 'Payment ref'),
      col('event_type', 'Type'),
      col('payment_method', 'Method'),
      col('amount_cents', 'Amount KES', true),
      col('tendered_cents', 'Tendered KES', true),
      col('change_cents', 'Change KES', true),
      col('staff', 'User'),
    ],
  },
  journal: {
    name: 'Accounting journal',
    description: 'Balanced, append-only operational journal entries, linked to approvals where applicable.',
    permission: 'reports.read',
    filters: ['staff'],
    columns: [
      col('date', 'Date'),
      col('reference', 'Reference'),
      col('account', 'Account'),
      col('description', 'Description'),
      col('debit_cents', 'Debit KES', true),
      col('credit_cents', 'Credit KES', true),
      col('staff', 'User'),
      col('approval_id', 'Approval ID'),
    ],
  },
};
export const filterSchema = z.object({
  staff: z.string().max(150).optional(),
  product: z.string().max(150).optional(),
  category: z.string().max(150).optional(),
  brand: z.string().max(150).optional(),
  supplier: z.string().max(200).optional(),
  payment: z.string().max(20).optional(),
});
export function inventoryReport(db: DB, a: Actor, r: Range): Row[] {
  const [start, end] = bounds(r);
  return all(
    db,
    `SELECT p.id product_id,p.name product_name,p.sku,b.name brand,c.name category,s.name supplier,
    COALESCE(SUM(CASE WHEN m.created_at<? THEN m.quantity ELSE 0 END),0) opening_stock,
    COALESCE(SUM(CASE WHEN m.created_at>=? AND m.kind='purchase' THEN m.quantity ELSE 0 END),0) purchases,
    -COALESCE(SUM(CASE WHEN m.created_at>=? AND m.kind='sale' THEN m.quantity ELSE 0 END),0) sales,
    COALESCE(SUM(CASE WHEN m.created_at>=? AND m.kind='return' THEN m.quantity ELSE 0 END),0) returns,
    -COALESCE(SUM(CASE WHEN m.created_at>=? AND m.kind='damaged' THEN m.quantity ELSE 0 END),0) damaged,
    -COALESCE(SUM(CASE WHEN m.created_at>=? AND m.kind='wastage' THEN m.quantity ELSE 0 END),0) wastage,
    COALESCE(SUM(CASE WHEN m.created_at>=? AND m.kind NOT IN('purchase','sale','return','damaged','wastage') THEN m.quantity ELSE 0 END),0) adjustments,
    COALESCE(SUM(m.quantity),0) closing_stock,COALESCE(SUM(m.value_delta_cents),0) stock_value_cents
    FROM products p JOIN brands b ON b.id=p.brand_id JOIN categories c ON c.id=p.category_id LEFT JOIN suppliers s ON s.id=p.supplier_id
    LEFT JOIN inventory_movements m ON m.product_id=p.id AND m.business_id=p.business_id AND m.branch_id=? AND m.created_at<?
    WHERE p.business_id=? GROUP BY p.id ORDER BY p.name`,
    start,
    start,
    start,
    start,
    start,
    start,
    start,
    a.branch_id,
    end,
    a.business_id,
  );
}
export function getReport(db: DB, a: Actor, type: string, query: Record<string, unknown>) {
  const definition = REPORTS[type];
  requireThat(definition, 'Report not found.', 404);
  demand(a, definition.permission);
  const range = readRange(query),
    filters = filterSchema.parse(query),
    [start, end] = bounds(range);
  for (const [key, value] of Object.entries(filters))
    if (value)
      requireThat(definition.filters.includes(key), `${key} filtering is not available for this report.`);
  let rows: Row[] = [];
  if (type === 'sales' || type === 'profit') rows = saleEvents(db, a, range);
  else if (type === 'inventory') rows = inventoryReport(db, a, range);
  else if (type === 'expenses') rows = expenseEvents(db, a, range);
  else if (type === 'staff') rows = staffPerformance(db, a, range);
  else if (type === 'purchases') {
    const positive = all(
      db,
      `SELECT p.id,p.ref,pr.created_at,p.supplier_name supplier,pi.product_id,pi.product_name,pi.quantity,pi.cost_cents,pi.total_cents,p.payment_method,p.user_id staff_id,u.name staff FROM purchases p JOIN purchase_receipts pr ON pr.purchase_id=p.id JOIN purchase_items pi ON pi.purchase_id=p.id JOIN users u ON u.id=p.user_id WHERE p.business_id=? AND p.branch_id=? AND pr.created_at>=? AND pr.created_at<? LIMIT 50001`,
      a.business_id,
      a.branch_id,
      start,
      end,
    );
    const negative = all(
      db,
      `SELECT pr.id,pr.ref,pr.created_at,p.supplier_name supplier,pi.product_id,pi.product_name,-pi.quantity quantity,pi.cost_cents,-pi.total_cents total_cents,p.payment_method,pr.user_id staff_id,u.name staff FROM purchase_reversals pr JOIN purchases p ON p.id=pr.purchase_id JOIN purchase_items pi ON pi.purchase_id=p.id JOIN users u ON u.id=pr.user_id WHERE pr.business_id=? AND pr.branch_id=? AND pr.created_at>=? AND pr.created_at<? LIMIT 50001`,
      a.business_id,
      a.branch_id,
      start,
      end,
    );
    rows = limited([...positive, ...negative]).map((r) => ({
      ...r,
      date: kenyaDate(new Date(r.created_at)),
    }));
  } else if (type === 'payments')
    rows = all(
      db,
      `SELECT p.*,s.ref transaction_ref,p.method payment_method,p.user_id staff_id,u.name staff,CASE WHEN p.reversal_id IS NULL THEN 'tender' ELSE 'refund' END event_type FROM payments p JOIN sales s ON s.id=p.sale_id JOIN users u ON u.id=p.user_id WHERE p.business_id=? AND p.branch_id=? AND p.created_at>=? AND p.created_at<? LIMIT 50001`,
      a.business_id,
      a.branch_id,
      start,
      end,
    );
  else if (type === 'approvals')
    rows = all(
      db,
      'SELECT r.*,r.user_id staff_id,u.name staff,rv.name reviewer FROM approval_requests r JOIN users u ON u.id=r.user_id LEFT JOIN users rv ON rv.id=r.reviewer_id WHERE r.business_id=? AND r.branch_id=? AND r.created_at>=? AND r.created_at<? LIMIT 50001',
      a.business_id,
      a.branch_id,
      start,
      end,
    );
  else if (type === 'audit')
    rows = all(
      db,
      'SELECT l.*,l.user_id staff_id,u.name staff FROM audit_logs l JOIN users u ON u.id=l.user_id WHERE l.business_id=? AND l.branch_id=? AND l.created_at>=? AND l.created_at<? ORDER BY l.seq DESC LIMIT 50001',
      a.business_id,
      a.branch_id,
      start,
      end,
    );
  else if (type === 'journal')
    rows = all(
      db,
      'SELECT l.*,e.reference,e.description,e.created_at,e.approval_id,e.user_id staff_id,u.name staff FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id JOIN users u ON u.id=e.user_id WHERE l.business_id=? AND l.branch_id=? AND e.created_at>=? AND e.created_at<? LIMIT 50001',
      a.business_id,
      a.branch_id,
      start,
      end,
    );
  limited(rows);
  rows = rows.filter(
    (row) =>
      (!filters.staff || row.staff_id === filters.staff) &&
      (!filters.product || row.product_id === filters.product) &&
      (!filters.category || row.category === filters.category) &&
      (!filters.brand || row.brand === filters.brand) &&
      (!filters.supplier || row.supplier === filters.supplier) &&
      (!filters.payment || String(row.payment_method).split(',').includes(filters.payment)),
  );
  if (type === 'profit')
    rows = aggregate(rows, 'product_id').map((g) => ({
      ...g,
      product_name: rows.find((r) => r.product_id === g.name)?.product_name ?? g.name,
      margin: g.revenue_cents ? Number(((g.profit_cents / g.revenue_cents) * 100).toFixed(2)) : null,
    }));
  rows = rows.map((r) => ({
    ...r,
    date:
      r.date ??
      (r.created_at
        ? type === 'audit'
          ? new Date(r.created_at).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })
          : kenyaDate(new Date(r.created_at))
        : ''),
  }));
  const totals: Row = {};
  for (const c of definition.columns)
    if (c.money) totals[c.key] = rows.reduce((sum, r) => sum + (r[c.key] ?? 0), 0);
  return {
    type,
    name: definition.name,
    description: definition.description,
    range,
    filters,
    columns: definition.columns,
    rows,
    totals,
    count: rows.length,
  };
}
export function csvCell(value: unknown) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+@\-\t\r]/.test(s) && !/^[-+]?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return `"${s.replaceAll('"', '""')}"`;
}
export function csvReport(report: ReturnType<typeof getReport>) {
  return (
    '\ufeff' +
    [
      report.columns.map((c) => csvCell(c.label)).join(','),
      ...report.rows.map((r) =>
        report.columns
          .map((c) =>
            csvCell(c.money && r[c.key] !== null && r[c.key] !== undefined ? amount(r[c.key]) : r[c.key]),
          )
          .join(','),
      ),
    ].join('\r\n')
  );
}
function pdfReport(res: Response, business: Row, report: ReturnType<typeof getReport>) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30, bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="kilele-${report.type}-${report.range.to}.pdf"`);
  doc.pipe(res);
  const columns = report.type === 'audit' ? report.columns.slice(0, 7) : report.columns;
  const usable = doc.page.width - 60,
    colWidth = usable / columns.length;
  let y = 0;
  const header = () => {
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#245745').text(business.name, 30, 28);
    doc.fontSize(13).fillColor('#26362c').text(report.name, 30, 53);
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#657168')
      .text(
        `${report.range.from} to ${report.range.to} · Africa/Nairobi · ${report.count} rows · Currency KES`,
        30,
        74,
      )
      .text(report.description, 30, 88, { width: usable });
    y = 118;
    doc.rect(30, y, usable, 25).fill('#edf2ec');
    columns.forEach((c, i) =>
      doc
        .fillColor('#34473b')
        .font('Helvetica-Bold')
        .fontSize(8)
        .text(c.label, 34 + i * colWidth, y + 6, { width: colWidth - 8, height: 18 }),
    );
    y += 29;
  };
  header();
  if (!report.rows.length)
    doc
      .font('Helvetica')
      .fontSize(11)
      .fillColor('#68746c')
      .text('No posted records match the selected filters.', 30, y + 25);
  report.rows.forEach((r, index) => {
    if (y > doc.page.height - 70) {
      doc.addPage();
      header();
    }
    if (index % 2 === 0) doc.rect(30, y, usable, 31).fill('#f7f8f5');
    columns.forEach((c, i) => {
      const raw = c.money && r[c.key] != null ? amount(r[c.key]) : String(r[c.key] ?? '—');
      doc
        .fillColor('#354037')
        .font('Helvetica')
        .fontSize(7)
        .text(raw, 34 + i * colWidth, y + 5, { width: colWidth - 8, height: 24, ellipsis: true });
    });
    y += 32;
  });
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(i);
    doc
      .fillColor('#68746c')
      .font('Helvetica')
      .fontSize(7)
      .text(
        `Generated ${new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })} EAT · Internal management report. Full detail available in CSV.`,
        30,
        doc.page.height - 35,
        { width: 650, lineBreak: false },
      )
      .text(`${i + 1} / ${pages.count}`, doc.page.width - 80, doc.page.height - 35, { lineBreak: false });
  }
  doc.end();
}
export function installReports(app: Express, db: DB) {
  app.get('/api/reports', protect(), (req, res) =>
    res.json({
      reports: Object.entries(REPORTS)
        .filter(([, d]) => can(req.actor, d.permission))
        .map(([key, d]) => ({ key, ...d })),
      staff:
        can(req.actor, 'reports.read') || can(req.actor, 'reports.inventory')
          ? all(
              db,
              'SELECT id,name FROM users WHERE business_id=? AND branch_id=? ORDER BY name',
              req.actor.business_id,
              req.actor.branch_id,
            )
          : [],
    }),
  );
  app.get('/api/reports/:type', protect(), (req, res) => {
    const report = getReport(db, req.actor, String(req.params.type), req.query),
      format = z.enum(['json', 'csv', 'pdf']).parse(req.query.format ?? 'json');
    if (format === 'json')
      return res.json({
        ...report,
        rows: report.rows.slice(0, 500),
        preview_limited: report.rows.length > 500,
      });
    audit(
      db,
      req.actor,
      'report.exported',
      'reports',
      report.type,
      null,
      { range: report.range, filters: report.filters, format, rows: report.count },
      'Authorised report export',
    );
    if (format === 'csv')
      return res
        .type('text/csv; charset=utf-8')
        .attachment(`kilele-${report.type}-${report.range.to}.csv`)
        .send(csvReport(report));
    pdfReport(res, one(db, 'SELECT * FROM businesses WHERE id=?', req.actor.business_id)!, report);
  });
}
