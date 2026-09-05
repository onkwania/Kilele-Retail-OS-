import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Package,
  Boxes,
  Truck,
  ClipboardList,
  Plus,
  ArrowUpRight,
  ShieldCheck,
  ArrowDownUp,
  TriangleAlert,
  History,
  RotateCcw,
} from 'lucide-react';
import { type Product, type Row, money, dateLabel } from '../lib/api';
import { useQuery, useAuth } from '../lib/state';
import {
  Button,
  Badge,
  PageHeader,
  Panel,
  SearchBox,
  Tabs,
  Pagination,
  Empty,
  Loading,
  ErrorState,
  Modal,
  Notice,
  ProductGlyph,
} from '../components/ui';
import { StockForm } from '../components/forms';
import { CorrectionModal, OriginalRecord } from '../components/CorrectionModal';
export default function Inventory() {
  const auth = useAuth(),
    navigate = useNavigate(),
    [params] = useSearchParams();
  const q = useQuery<{ products: Product[]; movements: Row[] }>('/inventory');
  const [tab, setTab] = useState('stock'),
    [search, setSearch] = useState(''),
    [filter, setFilter] = useState(params.get('filter') ?? ''),
    [category, setCategory] = useState(''),
    [page, setPage] = useState(1),
    [form, setForm] = useState<{ mode: string; product?: Product } | null>(null),
    [movement, setMovement] = useState<Row | null>(null),
    [correction, setCorrection] = useState<string | null>(null);
  const products = q.data?.products ?? [],
    movements = q.data?.movements ?? [];
  const filtered = products.filter(
    (p) =>
      `${p.name} ${p.sku} ${p.brand}`.toLowerCase().includes(search.toLowerCase()) &&
      (!category || p.category === category) &&
      (!filter ||
        (filter === 'low' &&
          Math.max(p.min_stock, p.reorder_level) > 0 &&
          p.stock <= Math.max(p.min_stock, p.reorder_level)) ||
        (filter === 'out' && p.stock === 0) ||
        (filter === 'in' && p.stock > 0)),
  );
  const ledger = movements.filter((m) =>
    `${m.reference} ${m.product_name} ${m.user_name} ${m.kind}`.toLowerCase().includes(search.toLowerCase()),
  );
  useEffect(() => setPage(1), [tab, search, filter, category]);
  return (
    <>
      <PageHeader
        eyebrow="KNOW WHAT’S ON YOUR SHELF"
        title="Inventory & stock"
        description="Every unit in, every unit out. One complete, traceable ledger."
        actions={
          <>
            {auth.can('inventory.opening') && (
              <Button variant="secondary" onClick={() => setForm({ mode: 'opening' })}>
                <Plus size={15} />
                Opening stock
              </Button>
            )}
            {auth.can('inventory.request') && (
              <Button variant="secondary" onClick={() => setForm({ mode: 'stock_count' })}>
                <ClipboardList size={15} />
                Stock count
              </Button>
            )}
            <Button onClick={() => navigate('/purchases?new=1')}>
              <Truck size={16} />
              Receive stock
            </Button>
          </>
        }
      />
      <div className="compact-stats">
        {[
          {
            label: 'Current stock value',
            value: money(products.reduce((s, p) => s + p.stock_value_cents, 0)),
            icon: Boxes,
          },
          {
            label: 'Units on hand',
            value: products.reduce((s, p) => s + p.stock, 0).toLocaleString(),
            icon: Package,
          },
          {
            label: 'Below reorder level',
            value: String(
              products.filter(
                (p) =>
                  Math.max(p.min_stock, p.reorder_level) > 0 &&
                  p.stock <= Math.max(p.min_stock, p.reorder_level),
              ).length,
            ),
            icon: TriangleAlert,
          },
          {
            label: 'Out-of-stock products',
            value: String(products.filter((p) => p.stock === 0).length),
            icon: ArrowDownUp,
          },
        ].map((s) => (
          <div className="compact-stat" key={s.label}>
            <span>
              <s.icon size={19} />
            </span>
            <div>
              <small>{s.label}</small>
              <strong>{s.value}</strong>
            </div>
          </div>
        ))}
      </div>
      <Panel>
        <Tabs
          items={[
            { id: 'stock', label: 'Stock levels', count: products.length },
            { id: 'ledger', label: 'Movement ledger', count: movements.length },
          ]}
          value={tab}
          onChange={setTab}
        />
        <div className="toolbar">
          <div className="toolbar-left">
            <SearchBox
              value={search}
              onChange={setSearch}
              placeholder={tab === 'stock' ? 'Search your stock…' : 'Search reference, product or staff…'}
            />
          </div>
          <div className="toolbar-right">
            {tab === 'stock' ? (
              <>
                <select
                  className="select-filter"
                  value={filter}
                  aria-label="Stock status"
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="">All stock levels</option>
                  <option value="in">In stock</option>
                  <option value="low">Low stock</option>
                  <option value="out">Out of stock</option>
                </select>
                <select
                  className="select-filter"
                  value={category}
                  aria-label="Category"
                  onChange={(e) => setCategory(e.target.value)}
                >
                  <option value="">All categories</option>
                  {[...new Set(products.map((p) => p.category))].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </>
            ) : (
              <Badge tone="green">
                <ShieldCheck size={12} />
                Append-only ledger
              </Badge>
            )}
          </div>
        </div>
        {q.loading ? (
          <Loading />
        ) : q.error ? (
          <ErrorState error={q.error} retry={q.refresh} />
        ) : tab === 'stock' ? (
          <>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>SKU</th>
                    <th>On hand</th>
                    <th>Opening units</th>
                    <th>Reorder level</th>
                    <th>Avg. recorded cost</th>
                    <th>Stock value</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice((page - 1) * 15, page * 15).map((p) => (
                    <tr key={p.id}>
                      <td>
                        <div className="product-name">
                          <ProductGlyph product={p} />
                          <div>
                            <strong>{p.name}</strong>
                            <small>
                              {p.size} · {p.category}
                            </small>
                          </div>
                        </div>
                      </td>
                      <td className="mono">{p.sku}</td>
                      <td>
                        <Badge
                          tone={
                            p.stock === 0
                              ? 'neutral'
                              : p.reorder_level > 0 && p.stock <= p.reorder_level
                                ? 'amber'
                                : 'green'
                          }
                        >
                          {p.stock} {p.unit}s
                        </Badge>
                      </td>
                      <td>{p.opening_stock ?? 0}</td>
                      <td>{p.reorder_level || 'Not configured'}</td>
                      <td>{p.stock ? money(p.stock_value_cents / p.stock, true) : '—'}</td>
                      <td className="money">{money(p.stock_value_cents, true)}</td>
                      <td>
                        {auth.can('inventory.request') && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setForm({ mode: 'stock_count', product: p })}
                          >
                            Count <ArrowUpRight size={12} />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!filtered.length && (
              <Empty
                title="No stock matches these filters"
                description="Adjust your search or clear the stock filters."
              />
            )}
            <Pagination page={page} setPage={setPage} total={filtered.length} />
          </>
        ) : (
          <>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Posted</th>
                    <th>Product</th>
                    <th>Movement</th>
                    <th>Quantity</th>
                    <th>Before → After</th>
                    <th>Reference</th>
                    <th>Recorded by</th>
                    <th>Approval</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.slice((page - 1) * 15, page * 15).map((m) => (
                    <tr className="clickable" key={m.id} onClick={() => setMovement(m)}>
                      <td>{dateLabel(m.created_at, true)}</td>
                      <td>
                        <strong>{m.product_name}</strong>
                        <small className="cell-sub">{m.sku}</small>
                      </td>
                      <td>
                        <Badge>{m.kind.replaceAll('_', ' ')}</Badge>
                      </td>
                      <td className={m.quantity > 0 ? 'positive' : 'negative'}>
                        {m.quantity > 0 ? '+' : ''}
                        {m.quantity}
                      </td>
                      <td>
                        {m.previous_qty} → <strong>{m.new_qty}</strong>
                      </td>
                      <td className="mono">{m.reference}</td>
                      <td>{m.user_name}</td>
                      <td>
                        <Badge tone="green">{m.approval_status}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!ledger.length && (
              <Empty
                icon={<History size={25} />}
                title="A clean ledger, ready to begin."
                description="Opening stock, receiving, sales, returns and approved adjustments create a permanent movement here."
                action={
                  auth.can('inventory.opening') ? (
                    <Button variant="secondary" onClick={() => setForm({ mode: 'opening' })}>
                      Enter opening stock
                    </Button>
                  ) : undefined
                }
              />
            )}
            <Pagination page={page} setPage={setPage} total={ledger.length} />
          </>
        )}
        <div className="table-note">
          <ShieldCheck size={13} />
          Balances come from recorded movements, not editable quantity fields. Costing uses moving weighted
          average.
        </div>
      </Panel>
      {form && (
        <StockForm
          {...form}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            q.refresh();
          }}
        />
      )}
      {movement && (
        <Modal
          title="Inventory movement"
          description={`${movement.reference} · ${dateLabel(movement.created_at, true)}`}
          onClose={() => setMovement(null)}
          wide
        >
          <div className="stack">
            <Notice>
              This movement is permanent. The previous and new quantities are preserved alongside its reason
              and author.
            </Notice>
            <OriginalRecord value={movement} />
            {auth.can('inventory.request') &&
              ['opening', 'adjustment', 'count', 'wastage', 'damaged'].includes(movement.kind) && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setCorrection(movement.id);
                    setMovement(null);
                  }}
                >
                  <RotateCcw size={15} />
                  Request a reversal
                </Button>
              )}
            {movement.approval_id && (
              <Button variant="secondary" onClick={() => navigate('/approvals?id=' + movement.approval_id)}>
                View approval <ArrowUpRight size={14} />
              </Button>
            )}
          </div>
        </Modal>
      )}
      {correction && (
        <CorrectionModal
          initialKind="stock_reversal"
          entityId={correction}
          onClose={() => setCorrection(null)}
          onSaved={() => {
            setCorrection(null);
            q.refresh();
          }}
        />
      )}
    </>
  );
}
