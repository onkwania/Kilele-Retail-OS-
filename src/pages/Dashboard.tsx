import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowUpRight,
  ArrowRight,
  Plus,
  TrendingUp,
  Wallet,
  ReceiptText,
  ShoppingBag,
  Package,
  TriangleAlert,
  ShieldCheck,
  Scale,
  Check,
  CheckCheck,
  ChevronRight,
  ChartNoAxesCombined,
  Sparkles,
  Boxes,
  Users,
  Clock3,
} from 'lucide-react';
import { useQuery, useAuth } from '../lib/state';
import {
  money,
  numeric,
  dateLabel,
  today,
  daysAgo,
  initials,
  titleCase,
  queryString,
  type Row,
} from '../lib/api';
import {
  Badge,
  Button,
  Empty,
  ErrorState,
  Loading,
  PageHeader,
  Panel,
  RangeControl,
  CategoryIcon,
} from '../components/ui';
import { TrendChart, PaymentRing, PAYMENT_COLORS } from '../components/charts';
export default function Dashboard() {
  const navigate = useNavigate(),
    auth = useAuth();
  const [range, setRange] = useState({ from: daysAgo(6), to: today() }),
    [metric, setMetric] = useState('sales');
  const q = useQuery('/dashboard?' + queryString(range));
  if (q.loading && !q.data)
    return (
      <>
        <PageHeader
          eyebrow="YOUR BUSINESS, AT A GLANCE"
          title="Business overview"
          description="A little clarity for a great day ahead."
        />
        <div className="dashboard-skeleton">
          <div />
          <div />
          <div />
          <div />
        </div>
        <Loading label="Gathering your business overview…" />
      </>
    );
  if (q.error) return <ErrorState error={q.error} retry={q.refresh} />;
  if (!q.data) return null;
  const d = q.data;
  const setupCount =
    1 + (d.setup.priced > 0 ? 1 : 0) + (d.setup.stocked > 0 ? 1 : 0) + (d.setup.sales > 0 ? 1 : 0);
  const cards = [
    {
      label: "Today's sales",
      value: d.today.gross_cents,
      icon: ShoppingBag,
      color: 'green',
      detail: d.today.transactions
        ? `${d.today.transactions} completed transaction${d.today.transactions !== 1 ? 's' : ''}`
        : 'Ready for your first sale',
      path: '/sales',
    },
    {
      label: "Today's gross profit",
      value: d.today.profit_cents,
      icon: TrendingUp,
      color: 'sage',
      detail:
        d.today.gross_margin == null
          ? 'Calculated from recorded costs'
          : `${d.today.gross_margin.toFixed(1)}% gross margin`,
      path: '/reports?type=profit',
    },
    {
      label: "Today's expenses",
      value: d.today.expenses_cents,
      icon: Wallet,
      color: 'sand',
      detail: d.today.expenses_cents ? 'Posted expenses, net of reversals' : 'No expenses recorded today',
      path: '/expenses',
    },
    {
      label: 'Transactions',
      value: d.today.transactions,
      icon: ReceiptText,
      color: 'lavender',
      detail: d.today.transactions
        ? `${money(d.today.average_cents)} average sale`
        : 'A new day of possibilities',
      path: '/sales',
      count: true,
    },
  ];
  const small = [
    {
      label: 'Stock value',
      value: money(d.inventory.value_cents),
      icon: Package,
      note: `${d.inventory.total_units.toLocaleString()} units on hand`,
      path: '/inventory',
    },
    {
      label: 'Low-stock items',
      value: String(d.inventory.low_stock),
      icon: TriangleAlert,
      note: d.inventory.low_stock ? 'Time to review your shelves' : 'No reorder alerts',
      path: '/inventory?filter=low',
    },
    {
      label: 'Pending approvals',
      value: String(d.pending),
      icon: ShieldCheck,
      note: d.pending ? 'Ready for your review' : 'Everything is up to date',
      path: '/approvals',
    },
    {
      label: 'Cash variance',
      value: money(d.cash_variance_cents),
      icon: Scale,
      note: 'Submitted closing balances',
      path: '/reconciliation',
    },
  ];
  return (
    <div className="dashboard-page">
      <PageHeader
        eyebrow="YOUR BUSINESS, AT A GLANCE"
        title="Business overview"
        description={<>Here’s how things are looking. Let’s make it a good day.</>}
        actions={
          <>
            <div className="today-label">
              {new Date().toLocaleDateString('en-GB', {
                timeZone: 'Africa/Nairobi',
                weekday: 'short',
                day: '2-digit',
                month: 'short',
                year: 'numeric',
              })}
            </div>
            <Button onClick={() => navigate('/pos')}>
              <Plus size={17} />
              New sale
            </Button>
          </>
        }
      />
      {setupCount < 4 && (
        <div className="welcome-banner">
          <div className="welcome-symbol">
            <Sparkles size={23} />
          </div>
          <div className="welcome-copy">
            <div>
              <strong>Your catalogue is ready. Make it yours.</strong>
              <Badge tone="green">LET’S GET YOU STARTED</Badge>
            </div>
            <p>{d.setup.products} sourced products. Add your prices and opening stock to start selling.</p>
          </div>
          <button
            className="banner-button"
            onClick={() => navigate(d.setup.priced ? '/inventory' : '/pricing')}
          >
            {d.setup.priced ? 'Add opening stock' : 'Set up prices'}
            <ArrowRight size={16} />
          </button>
        </div>
      )}
      <div className="section-caption">
        <span>
          <span className="live-dot" />
          TODAY’S SNAPSHOT
        </span>
        <span>All amounts in Kenyan shillings</span>
      </div>
      <div className="stat-grid">
        {cards.map((c) => (
          <button className="stat-card" key={c.label} onClick={() => navigate(c.path)}>
            <div className="stat-top">
              <span>{c.label}</span>
              <div className={`stat-icon ${c.color}`}>
                <c.icon size={18} strokeWidth={1.6} />
              </div>
            </div>
            <div className="stat-value">
              {!c.count && <small>KES</small>}
              {c.count
                ? c.value
                : new Intl.NumberFormat('en-KE', { maximumFractionDigits: 2 }).format(c.value / 100)}
            </div>
            <div className="stat-bottom">
              <span>
                <i />
                {c.detail}
              </span>
              <ArrowUpRight size={15} />
            </div>
          </button>
        ))}
      </div>
      <div className="quick-metrics">
        {small.map((c) => (
          <button key={c.label} onClick={() => navigate(c.path)}>
            <span className="quick-metric-icon">
              <c.icon size={18} strokeWidth={1.6} />
            </span>
            <div>
              <span>{c.label}</span>
              <strong>{c.value}</strong>
              <small>{c.note}</small>
            </div>
            <ChevronRight size={14} />
          </button>
        ))}
      </div>
      <div className="analytics-heading">
        <h2>
          See the bigger picture<span>Performance & insights</span>
        </h2>
        <RangeControl range={range} onChange={setRange} />
      </div>
      <div className="dashboard-charts">
        <Panel
          className="sales-chart-panel"
          title="Sales performance"
          subtitle="A little perspective on your business."
          action={
            <div className="mini-segment">
              <button className={metric === 'sales' ? 'active' : ''} onClick={() => setMetric('sales')}>
                Sales
              </button>
              <button className={metric === 'profit' ? 'active' : ''} onClick={() => setMetric('profit')}>
                Profit
              </button>
            </div>
          }
        >
          <div className="trend-total">
            <strong>
              {money(metric === 'sales' ? d.summary.gross_cents : d.summary.profit_cents, true)}
            </strong>
            <Badge>
              {range.from === range.to
                ? 'Selected day'
                : `${Math.round((new Date(range.to).getTime() - new Date(range.from).getTime()) / 86400000) + 1} days`}
            </Badge>
          </div>
          <TrendChart
            data={d.series}
            first={metric === 'sales' ? 'sales_cents' : 'profit_cents'}
            showSecond={metric === 'sales'}
            second="profit_cents"
          />
          <div className="chart-footer">
            <div>
              <span className="legend-dot forest" />
              {metric === 'sales' ? 'Net sales' : 'Gross profit'}{' '}
              {metric === 'sales' && (
                <>
                  <span className="legend-dot gold" />
                  Gross profit
                </>
              )}
            </div>
            <span>
              {d.summary.transactions} transaction{d.summary.transactions !== 1 ? 's' : ''} in this period
            </span>
          </div>
        </Panel>
        <Panel
          title="Payment breakdown"
          subtitle="Every shilling, in the right place."
          className="payment-panel"
        >
          <PaymentRing data={d.payments} total={d.summary.gross_cents} />
          <div className="payment-legend">
            {Object.entries(PAYMENT_COLORS).map(([method, color]) => {
              const row = d.payments.find((r: Row) => r.method === method);
              return (
                <div key={method}>
                  <span style={{ background: color }} />
                  <span>{method}</span>
                  <strong>{money(row?.amount_cents ?? 0)}</strong>
                  <small>
                    {d.summary.gross_cents > 0
                      ? `${Math.round(((row?.amount_cents ?? 0) / d.summary.gross_cents) * 100)}%`
                      : '—'}
                  </small>
                </div>
              );
            })}
          </div>
        </Panel>
      </div>
      <div className="dashboard-mid">
        <Panel
          title="Your best sellers"
          subtitle="The products moving your business forward."
          action={
            <button className="text-button" onClick={() => navigate('/reports?type=profit')}>
              View report <ArrowUpRight size={14} />
            </button>
          }
        >
          <div className="mini-table-wrap">
            <table className="data-table mini-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Units sold</th>
                  <th>Net revenue</th>
                  <th>Margin</th>
                </tr>
              </thead>
              <tbody>
                {d.top_products.map((p: Row, i: number) => (
                  <tr key={p.product_id}>
                    <td>
                      <div className="product-mini">
                        <span className="rank-number">{String(i + 1).padStart(2, '0')}</span>
                        <span>
                          <strong>{p.name}</strong>
                          <small>
                            {p.size} · {p.category}
                          </small>
                        </span>
                      </div>
                    </td>
                    <td>{p.quantity}</td>
                    <td className="money">{money(p.revenue_cents)}</td>
                    <td>{p.margin == null ? '—' : p.margin.toFixed(1) + '%'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!d.top_products.length && (
              <Empty
                compact
                icon={<ChartNoAxesCombined size={23} />}
                title="Good things are waiting on your shelf."
                description="Your best-selling products will appear here once sales begin."
                action={
                  <button className="text-button" onClick={() => navigate('/products')}>
                    Explore your catalogue <ArrowRight size={14} />
                  </button>
                }
              />
            )}
          </div>
        </Panel>
        <Panel
          title={setupCount < 4 ? 'Ready, set, open.' : 'Business health'}
          subtitle={
            setupCount < 4
              ? 'A few small steps. A strong foundation.'
              : 'Keep your daily operations in check.'
          }
          className="setup-panel"
        >
          <div className="setup-progress">
            <strong>
              {setupCount} <span>of 4 complete</span>
            </strong>
            <span>{Math.round((setupCount / 4) * 100)}%</span>
          </div>
          <div className="progress-track">
            <span style={{ width: (setupCount / 4) * 100 + '%' }} />
          </div>
          <div className="checklist">
            {[
              {
                label: 'Your starter catalogue',
                note: `${d.setup.products} real products. No made-up prices.`,
                done: true,
                path: '/products',
              },
              {
                label: 'Set your prices',
                note: `${d.setup.priced} products priced`,
                done: d.setup.priced > 0,
                path: '/pricing',
              },
              {
                label: 'Record opening stock',
                note: `${d.setup.stocked} products on the shelf`,
                done: d.setup.stocked > 0,
                path: '/inventory',
              },
              {
                label: 'Make your first sale',
                note: 'Open a register and you’re ready.',
                done: d.setup.sales > 0,
                path: '/pos',
              },
            ].map((s) => (
              <button key={s.label} onClick={() => navigate(s.path)}>
                <span className={`checklist-check ${s.done ? 'done' : ''}`}>
                  {s.done ? <Check size={13} /> : null}
                </span>
                <span>
                  <strong>{s.label}</strong>
                  <small>{s.note}</small>
                </span>
                <ChevronRight size={14} />
              </button>
            ))}
          </div>
        </Panel>
      </div>
      <div className="dashboard-lower">
        <Panel title="Sales by category" subtitle="Find what your customers come back for.">
          {d.categories.length ? (
            <div className="category-bars">
              {d.categories.map((c: Row) => (
                <div key={c.name}>
                  <span>
                    <CategoryIcon category={c.name} />
                    {c.name}
                  </span>
                  <strong>{money(c.revenue_cents)}</strong>
                  <div>
                    <i
                      style={{
                        width:
                          Math.max(0, (c.revenue_cents / Math.max(1, d.summary.revenue_cents)) * 100) + '%',
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="category-empty">
              <div className="category-icon-row">
                {['Spirits', 'Wines', 'Beer & Cider', 'Soft Drinks'].map((c) => (
                  <span key={c}>
                    <CategoryIcon category={c} />
                  </span>
                ))}
              </div>
              <strong>A shelf full of possibility</strong>
              <p>No category sales in this period.</p>
              <div className="catalogue-counts">
                {d.catalogue_categories.slice(0, 4).map((c: Row) => (
                  <div key={c.name}>
                    <span>{c.name}</span>
                    <b>{c.count} products</b>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Panel>
        <Panel
          title="Stock in. Stock out."
          subtitle="Movement backed by your inventory ledger."
          action={
            <button className="text-button" onClick={() => navigate('/inventory')}>
              <ArrowUpRight size={17} />
            </button>
          }
        >
          <TrendChart
            data={d.inventory_series}
            first="incoming"
            second="outgoing"
            unit="units"
            secondLabel="Units out"
            emptyTitle="Every bottle has a story."
            emptyDescription="Receiving, sales and approved adjustments appear here."
            compact
          />
          <div className="chart-footer">
            <div>
              <span className="legend-dot forest" />
              Units in <span className="legend-dot gold" />
              Units out
            </div>
            <Boxes size={17} />
          </div>
        </Panel>
      </div>
      <div className="dashboard-mid">
        <Panel
          title="People behind the numbers"
          subtitle="Operational performance. Always reviewed with context."
          action={
            <button className="text-button" onClick={() => navigate('/staff')}>
              View team <ArrowUpRight size={14} />
            </button>
          }
        >
          <div className="staff-snapshot">
            {d.staff.slice(0, 4).map((s: Row) => (
              <div key={s.id}>
                <span className="avatar avatar-small">{initials(s.name)}</span>
                <span>
                  <strong>{s.name}</strong>
                  <small>
                    {s.transactions} sales · {s.reconciliation_status}
                  </small>
                </span>
                <b>{money(s.sales_cents)}</b>
              </div>
            ))}
          </div>
          <div className="human-note">
            <Users size={14} />
            Figures support human review, never automatic accusations.
          </div>
        </Panel>
        <Panel
          title="The latest in your workspace"
          subtitle="A traceable record of what’s happening."
          action={
            <button className="text-button" onClick={() => navigate('/audit')}>
              <HistoryIcon />
            </button>
          }
        >
          <div className="activity-list">
            {d.activity.length ? (
              d.activity.slice(0, 4).map((e: Row) => (
                <div key={e.id}>
                  <span className="activity-icon">
                    {e.action === 'catalogue.seeded' ? <Package size={15} /> : <CheckCheck size={15} />}
                  </span>
                  <div>
                    <strong>
                      {e.action === 'catalogue.seeded'
                        ? 'Starter catalogue added'
                        : e.action === 'workspace.created'
                          ? 'Your workspace is ready'
                          : titleCase(e.action.replaceAll('.', ' '))}
                    </strong>
                    <p>
                      {e.user_name}
                      <i>·</i>
                      {dateLabel(e.created_at, true)}
                    </p>
                  </div>
                </div>
              ))
            ) : (
              <Empty compact title="A clear audit trail starts here." />
            )}
          </div>
        </Panel>
      </div>
      <div className="dashboard-note">
        <ShieldCheck size={15} />
        <span>Real numbers. Original records preserved. A clear view of your business.</span>
        <span>
          Operating result: <strong>{money(d.summary.operating_cents)}</strong>
        </span>
      </div>
      <span className="sr-only">
        Signed in as {auth.user!.name}. Total amount {numeric(d.summary.gross_cents)} Kenya shillings.
      </span>
    </div>
  );
}
function HistoryIcon() {
  return <Clock3 size={17} />;
}
