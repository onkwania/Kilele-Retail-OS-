import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ReceiptText,
  TrendingUp,
  Boxes,
  Wallet,
  Truck,
  Users,
  ShieldCheck,
  History,
  Landmark,
  BookOpen,
  Download,
  FileText,
  ArrowRight,
  SlidersHorizontal,
  CalendarDays,
  CheckCircle2,
} from 'lucide-react';
import { download, type Row, type Product, money, dateLabel, today, daysAgo, queryString } from '../lib/api';
import { useQuery, useAction } from '../lib/state';
import {
  Button,
  Badge,
  PageHeader,
  Panel,
  Field,
  Input,
  RangeControl,
  Notice,
  Empty,
  Loading,
  ErrorState,
} from '../components/ui';
import { EXPENSE_CATEGORIES } from '../components/forms';
const icons: Record<string, typeof ReceiptText> = {
  sales: ReceiptText,
  profit: TrendingUp,
  inventory: Boxes,
  expenses: Wallet,
  purchases: Truck,
  staff: Users,
  approvals: ShieldCheck,
  audit: History,
  payments: Landmark,
  journal: BookOpen,
};
export default function Reports() {
  const [params] = useSearchParams();
  const meta = useQuery('/reports'),
    productsQ = useQuery<{ products: Product[] }>('/products');
  const a = useAction();
  const [type, setType] = useState(params.get('type') ?? 'sales'),
    [range, setRange] = useState({ from: daysAgo(6), to: today() }),
    [filters, setFilters] = useState({
      staff: '',
      product: '',
      category: '',
      brand: '',
      supplier: '',
      payment: '',
    }),
    [advanced, setAdvanced] = useState(false),
    [applied, setApplied] = useState<Row>({
      type: params.get('type') ?? 'sales',
      from: daysAgo(6),
      to: today(),
    });
  const definition = meta.data?.reports.find((r: Row) => r.key === type);
  const q = useQuery(
    meta.data?.reports.some((r: Row) => r.key === applied.type)
      ? `/reports/${applied.type}?${queryString({ ...applied, type: undefined })}`
      : null,
  );
  const products = productsQ.data?.products ?? [];
  useEffect(() => {
    if (meta.data && !meta.data.reports.some((r: Row) => r.key === type) && meta.data.reports.length) {
      setType(meta.data.reports[0].key);
    }
  }, [meta.data, type]);
  useEffect(() => {
    setFilters({ staff: '', product: '', category: '', brand: '', supplier: '', payment: '' });
    setApplied({ type, from: range.from, to: range.to });
  }, [type]);
  const setFilter = (k: string, v: string) => setFilters((old) => ({ ...old, [k]: v }));
  const has = (key: string) => definition?.filters.includes(key);
  const exportReport = (format: string) =>
    void a.run(
      () =>
        download(
          `/reports/${applied.type}?${queryString({ ...applied, type: undefined, format })}`,
          `kilele-${applied.type}-${applied.to}.${format}`,
        ),
      'Your report is ready.',
    );
  const totalKeys: Record<string, string[]> = {
    sales: ['total_cents'],
    profit: ['revenue_cents', 'cogs_cents', 'profit_cents'],
    inventory: ['stock_value_cents'],
    expenses: ['amount_cents'],
    purchases: ['total_cents'],
    payments: ['amount_cents'],
    journal: ['debit_cents', 'credit_cents'],
    staff: ['sales_cents'],
  };
  return (
    <>
      <PageHeader
        eyebrow="GOOD DECISIONS START WITH CLEAR NUMBERS"
        title="Reports & insights"
        description="Follow the money, understand your products, and keep an accurate record."
        actions={
          <Badge tone="green">
            <ShieldCheck size={13} />
            Based on posted records
          </Badge>
        }
      />
      {meta.loading ? (
        <Loading />
      ) : meta.error ? (
        <ErrorState error={meta.error} retry={meta.refresh} />
      ) : (
        <>
          <div className="report-type-grid">
            {meta.data?.reports.map((r: Row) => {
              const Icon = icons[r.key] ?? FileText;
              return (
                <button key={r.key} className={type === r.key ? 'active' : ''} onClick={() => setType(r.key)}>
                  <span>
                    <Icon size={18} />
                  </span>
                  <strong>{r.name}</strong>
                  {type === r.key && <CheckCircle2 size={14} />}
                </button>
              );
            })}
          </div>
          <Panel className="report-controls">
            <div className="panel-header">
              <div>
                <h2>{definition?.name}</h2>
                <p>{definition?.description}</p>
              </div>
              <RangeControl range={range} onChange={setRange} />
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setApplied({ type, ...range, ...filters });
              }}
            >
              <div className="report-filters">
                {has('staff') && (
                  <Field label="Staff member">
                    <select value={filters.staff} onChange={(e) => setFilter('staff', e.target.value)}>
                      <option value="">All staff</option>
                      {meta.data?.staff.map((u: Row) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {has('product') && (
                  <Field label="Product">
                    <select value={filters.product} onChange={(e) => setFilter('product', e.target.value)}>
                      <option value="">All products</option>
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} · {p.size}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {has('payment') && (
                  <Field label="Payment method">
                    <select value={filters.payment} onChange={(e) => setFilter('payment', e.target.value)}>
                      <option value="">All methods</option>
                      {['Cash', 'M-Pesa', 'Card', 'Bank'].map((m) => (
                        <option key={m}>{m}</option>
                      ))}
                      {type === 'purchases' && <option>Credit</option>}
                    </select>
                  </Field>
                )}
                <div className="report-filter-actions">
                  <Button type="button" variant="secondary" onClick={() => setAdvanced(!advanced)}>
                    <SlidersHorizontal size={14} />
                    More filters
                  </Button>
                  <Button type="submit">
                    <ArrowRight size={15} />
                    Run report
                  </Button>
                </div>
              </div>
              {advanced && (
                <div className="report-filters additional-filters">
                  <Field label="From date">
                    <Input
                      type="date"
                      required
                      value={range.from}
                      max={range.to}
                      onChange={(e) => setRange((old) => ({ ...old, from: e.target.value }))}
                    />
                  </Field>
                  <Field label="To date">
                    <Input
                      type="date"
                      required
                      value={range.to}
                      max={today()}
                      min={range.from}
                      onChange={(e) => setRange((old) => ({ ...old, to: e.target.value }))}
                    />
                  </Field>
                  {has('category') && (
                    <Field label="Category">
                      <Input
                        list="report-categories"
                        value={filters.category}
                        onChange={(e) => setFilter('category', e.target.value)}
                        placeholder="All categories"
                      />
                      <datalist id="report-categories">
                        {(type === 'expenses'
                          ? EXPENSE_CATEGORIES
                          : [...new Set(products.map((p) => p.category))]
                        ).map((c) => (
                          <option key={c}>{c}</option>
                        ))}
                      </datalist>
                    </Field>
                  )}
                  {has('brand') && (
                    <Field label="Brand">
                      <Input
                        list="report-brands"
                        value={filters.brand}
                        onChange={(e) => setFilter('brand', e.target.value)}
                        placeholder="All brands"
                      />
                      <datalist id="report-brands">
                        {[...new Set(products.map((p) => p.brand))].map((b) => (
                          <option key={b}>{b}</option>
                        ))}
                      </datalist>
                    </Field>
                  )}
                  {has('supplier') && (
                    <Field label={type === 'expenses' ? 'Payee name' : 'Supplier name'}>
                      <Input
                        value={filters.supplier}
                        onChange={(e) => setFilter('supplier', e.target.value)}
                        placeholder="All suppliers / payees"
                      />
                    </Field>
                  )}
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      setFilters({
                        staff: '',
                        product: '',
                        category: '',
                        brand: '',
                        supplier: '',
                        payment: '',
                      })
                    }
                  >
                    Clear optional filters
                  </button>
                </div>
              )}
            </form>
          </Panel>
          <Panel className="margin-top">
            <div className="panel-header">
              <div>
                <h2>Report preview</h2>
                <p>
                  <CalendarDays size={11} /> {dateLabel(applied.from)} — {dateLabel(applied.to)} ·
                  Africa/Nairobi
                </p>
              </div>
              <div className="inline">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!q.data || q.loading || !!q.error}
                  busy={a.busy}
                  onClick={() => exportReport('csv')}
                >
                  <Download size={14} />
                  CSV
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!q.data || q.loading || !!q.error}
                  busy={a.busy}
                  onClick={() => exportReport('pdf')}
                >
                  <FileText size={14} />
                  PDF
                </Button>
              </div>
            </div>
            {q.loading ? (
              <Loading label="Reading the accounting ledger…" />
            ) : q.error ? (
              <ErrorState error={q.error} retry={q.refresh} />
            ) : (
              q.data && (
                <>
                  <div className="report-summary">
                    <div>
                      <span>Matching records</span>
                      <strong>{q.data.count.toLocaleString()}</strong>
                    </div>
                    {(totalKeys[applied.type] ?? []).map((key) => (
                      <div key={key}>
                        <span>
                          {q.data!.columns.find((c: Row) => c.key === key)?.label?.replace(' KES', '') ?? key}
                        </span>
                        <strong>{money(q.data!.totals[key] ?? 0, true)}</strong>
                      </div>
                    ))}
                  </div>
                  <div className="table-wrap">
                    <table className="data-table report-table">
                      <thead>
                        <tr>
                          {q.data.columns.map((c: Row) => (
                            <th key={c.key}>{c.label}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {q.data.rows.map((r: Row, i: number) => (
                          <tr key={r.id ?? r.event_id ?? i}>
                            {q.data!.columns.map((c: Row) => (
                              <td
                                key={c.key}
                                className={c.money ? 'money' : ''}
                                title={String(r[c.key] ?? '')}
                              >
                                {c.money
                                  ? money(r[c.key], true)
                                  : r[c.key] === null || r[c.key] === undefined
                                    ? '—'
                                    : String(r[c.key]).length > 100
                                      ? String(r[c.key]).slice(0, 100) + '…'
                                      : String(r[c.key])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!q.data.rows.length && (
                    <Empty
                      icon={<FileText size={25} />}
                      title="A clean page for this period."
                      description="No posted records match these filters. Choose another date range or start recording transactions."
                    />
                  )}
                  <div className="table-note">
                    <ShieldCheck size={13} />
                    {q.data.preview_limited
                      ? 'Preview shows the first 500 rows. Exports include all matching rows.'
                      : 'All matching records shown.'}{' '}
                    CSV includes full field values.
                  </div>
                </>
              )
            )}
          </Panel>
          <div className="margin-top">
            <Notice>
              {type === 'sales' || type === 'profit'
                ? 'Returns are posted as negative entries on their approval date. A payment-method filter selects complete transactions containing that tender; use Payment reconciliation for exact tender amounts.'
                : type === 'inventory'
                  ? 'Inventory values are reconstructed at the selected end date. Opening-stock entries within the period appear under adjustments. Supplier filtering uses the product’s assigned supplier.'
                  : type === 'staff'
                    ? 'Performance figures are operational accounting information for human review, never automatic evidence of misconduct.'
                    : 'Reports preserve historical recorded amounts. CSV and PDF downloads are recorded in the immutable audit trail.'}
            </Notice>
          </div>
        </>
      )}
    </>
  );
}
