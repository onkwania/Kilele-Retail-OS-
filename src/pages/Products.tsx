import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Plus,
  SlidersHorizontal,
  Package,
  Tag,
  CheckCircle2,
  Boxes,
  ArrowUpRight,
  Pencil,
  ShieldCheck,
  History,
  Save,
} from 'lucide-react';
import { api, type Product, type Row, money, dateLabel, isReady } from '../lib/api';
import { useAuth, useQuery, useAction } from '../lib/state';
import {
  Button,
  IconButton,
  Badge,
  PageHeader,
  Panel,
  Input,
  Field,
  SearchBox,
  Tabs,
  Pagination,
  Empty,
  ErrorState,
  Loading,
  Notice,
  Modal,
  ProductGlyph,
  FileUpload,
  CategoryIcon,
} from '../components/ui';
export function ProductForm({
  product,
  onClose,
  onSaved,
}: {
  product?: Product;
  onClose: () => void;
  onSaved: () => void;
}) {
  const auth = useAuth(),
    navigate = useNavigate(),
    action = useAction();
  const meta = useQuery('/catalogue/meta'),
    suppliers = useQuery(auth.can('suppliers.read') ? '/suppliers' : null);
  const [tab, setTab] = useState('details');
  const history = useQuery(product && auth.can('prices.write') ? `/products/${product.id}/history` : null);
  const [form, setForm] = useState({
    name: product?.name ?? '',
    brand: product?.brand ?? '',
    category: product?.category ?? 'Spirits',
    subcategory: product?.subcategory ?? '',
    sku: product?.sku ?? '',
    barcode: product?.barcode ?? '',
    size: product?.size ?? '',
    unit: product?.unit ?? 'bottle',
    supplier_id: product?.supplier_id ?? null,
    min_stock: product?.min_stock ?? 0,
    reorder_level: product?.reorder_level ?? 0,
    active: product ? !!product.active : true,
    image: product?.image ?? '',
    notes: product?.notes ?? '',
    reason: '',
    ...(product ? { version: product.version } : {}),
  });
  const set = (key: string, value: unknown) => setForm((f) => ({ ...f, [key]: value }));
  const editable = auth.can('products.write');
  return (
    <Modal
      title={product ? product.name : 'Add a product'}
      description={
        product
          ? `${product.sku} · ${product.size} · ${product.unit}`
          : 'Extend your catalogue with a real product and a confirmed package size.'
      }
      onClose={onClose}
      wide
    >
      {product && auth.can('prices.write') && (
        <Tabs
          items={[
            { id: 'details', label: 'Product details' },
            { id: 'history', label: 'Price history' },
          ]}
          value={tab}
          onChange={setTab}
        />
      )}
      {tab === 'history' ? (
        <div className="detail-section">
          {history.loading ? (
            <Loading />
          ) : history.data?.history.length ? (
            <div className="price-history">
              {history.data.history.map((h: Row) => {
                const old = JSON.parse(h.previous_json),
                  next = JSON.parse(h.next_json);
                return (
                  <div key={h.id}>
                    <h4>
                      {h.user_name} <Badge>{dateLabel(h.created_at, true)}</Badge>
                    </h4>
                    <p>{h.reason}</p>
                    <div className="detail-list">
                      {[
                        ['cost_cents', 'Buying price'],
                        ['selling_cents', 'Selling price'],
                        ['wholesale_cents', 'Wholesale'],
                        ['promo_cents', 'Promotion'],
                      ].map(([k, l]) => (
                        <div key={k}>
                          <small>{l}</small>
                          <strong>
                            {money(old[k])} → {money(next[k])}
                          </strong>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <Empty
              compact
              icon={<History size={22} />}
              title="No price changes yet"
              description="Every saved price change will keep its previous value, author, time and reason."
            />
          )}
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(
              async () => {
                await api(product ? `/products/${product.id}` : '/products', {
                  method: product ? 'PATCH' : 'POST',
                  body: form,
                });
                onSaved();
              },
              product ? 'Product details saved.' : 'Product added. Set its prices to continue.',
            );
          }}
          className="product-form"
        >
          <div className="form-section margin-top">
            <h3>PRODUCT INFORMATION</h3>
            <div className="grid-2">
              <Field label="Product name" required>
                <Input
                  required
                  disabled={!editable}
                  value={form.name}
                  onChange={(e) => set('name', e.target.value)}
                  placeholder="Name exactly as shown on the package"
                />
              </Field>
              <Field label="Brand" required>
                <Input
                  required
                  disabled={!editable}
                  list="brands-list"
                  value={form.brand}
                  onChange={(e) => set('brand', e.target.value)}
                  placeholder="Select or enter a brand"
                />
                <datalist id="brands-list">
                  {meta.data?.brands.map((b: Row) => (
                    <option key={b.id}>{b.name}</option>
                  ))}
                </datalist>
              </Field>
              <Field label="Category" required>
                <Input
                  required
                  disabled={!editable}
                  list="category-list"
                  value={form.category}
                  onChange={(e) => set('category', e.target.value)}
                />
                <datalist id="category-list">
                  {meta.data?.categories.map((c: Row) => (
                    <option key={c.id}>{c.name}</option>
                  ))}
                </datalist>
              </Field>
              <Field label="Subcategory">
                <Input
                  disabled={!editable}
                  list="subcategory-list"
                  value={form.subcategory}
                  onChange={(e) => set('subcategory', e.target.value)}
                />
                <datalist id="subcategory-list">
                  {meta.data?.subcategories[form.category]?.subcategories.map((s: string) => (
                    <option key={s}>{s}</option>
                  ))}
                </datalist>
              </Field>
              <Field label="Internal SKU" hint="Leave blank to generate an internal SKU.">
                <Input
                  disabled={!editable}
                  value={form.sku}
                  onChange={(e) => set('sku', e.target.value)}
                  placeholder="Automatically generated"
                />
              </Field>
              <Field label="Barcode" hint="Scan the physical product or enter its exact barcode.">
                <Input
                  disabled={!editable}
                  value={form.barcode}
                  onChange={(e) => set('barcode', e.target.value)}
                  placeholder="Not assigned"
                />
              </Field>
              <Field label="Bottle / package size" hint="Use only a verified size, e.g. 750ml.">
                <Input
                  disabled={!editable}
                  value={form.size}
                  onChange={(e) => set('size', e.target.value)}
                  placeholder="Confirm package size"
                />
              </Field>
              <Field label="Unit of measure">
                <select disabled={!editable} value={form.unit} onChange={(e) => set('unit', e.target.value)}>
                  {['bottle', 'can', 'pack', 'case', 'unit', 'bag', 'kg'].map((u) => (
                    <option key={u}>{u}</option>
                  ))}
                </select>
              </Field>
            </div>
          </div>
          <div className="form-section">
            <h3>SUPPLIER & STOCK CONTROLS</h3>
            <div className="grid-2">
              <Field label="Preferred supplier">
                <select
                  disabled={!editable}
                  value={form.supplier_id ?? ''}
                  onChange={(e) => set('supplier_id', e.target.value || null)}
                >
                  <option value="">Not assigned</option>
                  {suppliers.data?.suppliers.map((s: Row) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="field">
                <span>Product status</span>
                <label className="checkbox-label">
                  <input
                    disabled={!editable}
                    type="checkbox"
                    checked={form.active}
                    onChange={(e) => set('active', e.target.checked)}
                  />
                  Active — available in the catalogue
                </label>
              </div>
              <Field label="Minimum stock level">
                <Input
                  disabled={!editable}
                  type="number"
                  min="0"
                  max="100000"
                  value={form.min_stock}
                  onChange={(e) => set('min_stock', Number(e.target.value))}
                />
              </Field>
              <Field label="Reorder level" hint="Set above zero to enable low-stock alerts.">
                <Input
                  disabled={!editable}
                  type="number"
                  min="0"
                  max="100000"
                  value={form.reorder_level}
                  onChange={(e) => set('reorder_level', Number(e.target.value))}
                />
              </Field>
            </div>
          </div>
          {editable && (
            <div className="form-section">
              <div className="grid-2">
                <Field label="Product notes">
                  <textarea
                    value={form.notes}
                    onChange={(e) => set('notes', e.target.value)}
                    maxLength={2000}
                  />
                </Field>
                <Field label="Product image">
                  <FileUpload
                    purpose="product"
                    label="Upload a product image"
                    value={form.image}
                    onUploaded={(_id, url) => set('image', url)}
                  />
                </Field>
              </div>
            </div>
          )}
          {product && (
            <div className="detail-grid">
              <div>
                <label>SELLING PRICE</label>
                <strong>{money(product.selling_cents)}</strong>
              </div>
              <div>
                <label>STOCK ON HAND</label>
                <strong>
                  {product.stock} {product.unit}s
                </strong>
              </div>
              <div>
                <label>TAX TREATMENT</label>
                <strong>
                  {product.tax_mode === 'unset'
                    ? 'Not configured'
                    : `${product.tax_mode} · ${product.tax_bps / 100}%`}
                </strong>
              </div>
            </div>
          )}
          {product?.source_url && (
            <p className="source-note">
              Starter catalogue reference:{' '}
              <a href={product.source_url} target="_blank" rel="noreferrer">
                View source listing <ArrowUpRight size={11} />
              </a>{' '}
              · Always confirm the physical package.
            </p>
          )}
          <Notice>
            <strong>Prices and stock are controlled separately.</strong> Use the price sheet for manual
            pricing, and the inventory ledger for opening stock or adjustments. Old transactions never change.
          </Notice>
          {editable && (
            <Field className="margin-top" label="Reason for this change" required>
              <Input
                required
                minLength={5}
                value={form.reason}
                onChange={(e) => set('reason', e.target.value)}
                placeholder={product ? 'Explain what changed and why' : 'Why are you adding this product?'}
              />
            </Field>
          )}
          {action.error && <p className="form-error margin-top">{action.error}</p>}
          <div className="form-footer">
            {product && auth.can('prices.write') && (
              <Button
                variant="secondary"
                type="button"
                onClick={() => {
                  onClose();
                  navigate('/pricing?ids=' + product.id);
                }}
              >
                Edit prices <ArrowUpRight size={14} />
              </Button>
            )}
            <Button variant="ghost" type="button" onClick={onClose}>
              {editable ? 'Cancel' : 'Close'}
            </Button>
            {editable && (
              <Button busy={action.busy} type="submit">
                <Save size={15} />
                {product ? 'Save product' : 'Add product'}
              </Button>
            )}
          </div>
        </form>
      )}
    </Modal>
  );
}
export default function Products() {
  const auth = useAuth(),
    navigate = useNavigate();
  const [params] = useSearchParams();
  const q = useQuery<{ products: Product[] }>('/products');
  const [search, setSearch] = useState(params.get('search') ?? ''),
    [tab, setTab] = useState('all'),
    [category, setCategory] = useState('All products'),
    [brand, setBrand] = useState(''),
    [page, setPage] = useState(1),
    [extra, setExtra] = useState(false),
    [low, setLow] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [edit, setEdit] = useState<Product | null | undefined>(undefined);
  const products = q.data?.products ?? [];
  const categories = useMemo(() => [...new Set(products.map((p) => p.category))], [products]);
  const brands = useMemo(() => [...new Set(products.map((p) => p.brand))].sort(), [products]);
  useEffect(() => {
    setPage(1);
  }, [search, tab, category, brand, low]);
  const filtered = products.filter(
    (p) =>
      `${p.name} ${p.brand} ${p.sku} ${p.barcode} ${p.category}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (category === 'All products' || p.category === category) &&
      (!brand || p.brand === brand) &&
      (!low || (p.reorder_level > 0 && p.stock <= p.reorder_level)) &&
      (tab === 'all' ||
        (tab === 'unpriced' && (p.selling_cents === null || p.cost_configured === 0)) ||
        (tab === 'ready' && isReady(p)) ||
        (tab === 'inactive' && !p.active)),
  );
  const pageRows = filtered.slice((page - 1) * 15, page * 15);
  const priced = products.filter((p) => p.selling_cents !== null && p.cost_configured === 1).length;
  return (
    <>
      <PageHeader
        eyebrow="A WELL-KEPT SHELF STARTS HERE"
        title="Product catalogue"
        description="Your products, your prices. Nothing set without your say."
        actions={
          <>
            {auth.can('prices.write') && (
              <Button variant="secondary" onClick={() => navigate('/pricing')}>
                <SlidersHorizontal size={16} />
                Bulk edit prices
              </Button>
            )}
            {auth.can('products.write') && (
              <Button onClick={() => setEdit(null)}>
                <Plus size={16} />
                Add product
              </Button>
            )}
          </>
        }
      />
      <div className="compact-stats">
        {[
          { label: 'Products in your catalogue', value: products.length, icon: Package },
          { label: 'Prices configured', value: priced, icon: CheckCircle2 },
          { label: 'Need your prices', value: products.length - priced, icon: Tag },
          { label: 'Products in stock', value: products.filter((p) => p.stock > 0).length, icon: Boxes },
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
            { id: 'all', label: 'All products', count: products.length },
            { id: 'unpriced', label: 'Price not set', count: products.length - priced },
            { id: 'ready', label: 'Ready to sell' },
            { id: 'inactive', label: 'Inactive' },
          ]}
          value={tab}
          onChange={setTab}
        />
        <div className="toolbar">
          <div className="toolbar-left">
            <SearchBox value={search} onChange={setSearch} placeholder="Search name, SKU or barcode…" />
          </div>
          <div className="toolbar-right">
            <select
              aria-label="Filter by brand"
              className="select-filter"
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
            >
              <option value="">All brands</option>
              {brands.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </select>
            <Button variant="secondary" size="sm" onClick={() => setExtra(!extra)}>
              <SlidersHorizontal size={14} />
              Filters
            </Button>
          </div>
        </div>
        {extra && (
          <div className="filters-extra">
            <label className="checkbox-label">
              <input type="checkbox" checked={low} onChange={(e) => setLow(e.target.checked)} />
              Below reorder level
            </label>
            <button
              className="text-button"
              onClick={() => {
                setSearch('');
                setBrand('');
                setCategory('All products');
                setLow(false);
                setTab('all');
              }}
            >
              Reset filters
            </button>
          </div>
        )}
        <div className="category-chips">
          {['All products', ...categories].map((c) => (
            <button className={category === c ? 'active' : ''} key={c} onClick={() => setCategory(c)}>
              {c === 'All products' ? <Package size={14} /> : <CategoryIcon category={c} />}
              <span>{c}</span>
              <small>
                {c === 'All products' ? products.length : products.filter((p) => p.category === c).length}
              </small>
            </button>
          ))}
        </div>
        {selected.length > 0 && auth.can('prices.write') && (
          <div className="selection-bar">
            <span>{selected.length} products selected</span>
            <Button size="sm" onClick={() => navigate('/pricing?ids=' + selected.join(','))}>
              Edit selected prices <ArrowUpRight size={14} />
            </Button>
          </div>
        )}
        {q.loading ? (
          <Loading label="Opening your catalogue…" />
        ) : q.error ? (
          <ErrorState error={q.error} retry={q.refresh} />
        ) : (
          <>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    {auth.can('prices.write') && (
                      <th>
                        <input
                          type="checkbox"
                          aria-label="Select products on this page"
                          checked={!!pageRows.length && pageRows.every((p) => selected.includes(p.id))}
                          onChange={(e) =>
                            setSelected(
                              e.target.checked
                                ? [...new Set([...selected, ...pageRows.map((p) => p.id)])]
                                : selected.filter((id) => !pageRows.some((p) => p.id === id)),
                            )
                          }
                        />
                      </th>
                    )}
                    <th>Product</th>
                    <th>SKU / Size</th>
                    <th>Category</th>
                    {auth.user?.role_id !== 'cashier' && <th>Buying price</th>}
                    <th>Selling price</th>
                    <th>Stock</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((p) => (
                    <tr className="clickable" key={p.id} onClick={() => setEdit(p)}>
                      {auth.can('prices.write') && (
                        <td onClick={(e) => e.stopPropagation()}>
                          <input
                            aria-label={`Select ${p.name} ${p.size}`}
                            type="checkbox"
                            checked={selected.includes(p.id)}
                            onChange={(e) =>
                              setSelected(
                                e.target.checked ? [...selected, p.id] : selected.filter((id) => id !== p.id),
                              )
                            }
                          />
                        </td>
                      )}
                      <td>
                        <div className="product-name">
                          <ProductGlyph product={p} />
                          <div>
                            <strong>{p.name}</strong>
                            <small>
                              {p.brand} · {p.subcategory}
                            </small>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className="mono">{p.sku}</span>
                        <small className="cell-sub">
                          {p.size || 'Confirm size'} · {p.unit}
                        </small>
                      </td>
                      <td>
                        <span className="category-label">
                          <i style={{ background: p.category_color }} />
                          {p.category}
                        </span>
                      </td>
                      {auth.user?.role_id !== 'cashier' && (
                        <td>
                          {p.cost_cents === null ? (
                            <span className="price-pill">Price not set</span>
                          ) : (
                            <span className="money">{money(p.cost_cents)}</span>
                          )}
                        </td>
                      )}
                      <td>
                        {p.selling_cents === null ? (
                          <span className="price-pill">Price not set</span>
                        ) : (
                          <strong className="money">{money(p.selling_cents)}</strong>
                        )}
                      </td>
                      <td>
                        <span className={p.stock ? '' : 'stock-zero'}>{p.stock}</span>
                        <small className="cell-sub">{p.unit}s</small>
                      </td>
                      <td>
                        <Badge
                          tone={!p.active ? 'neutral' : p.selling_cents === null ? 'amber' : 'green'}
                          dot
                        >
                          {!p.active ? 'Inactive' : p.selling_cents === null ? 'Needs pricing' : 'Active'}
                        </Badge>
                      </td>
                      <td>
                        <IconButton label={`Edit ${p.name} ${p.size}`}>
                          <Pencil size={14} />
                        </IconButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!filtered.length && (
              <Empty
                title="No products match your search"
                description="Try another brand, category, barcode or SKU."
                action={
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setSearch('');
                      setCategory('All products');
                      setBrand('');
                      setTab('all');
                      setLow(false);
                    }}
                  >
                    Clear filters
                  </Button>
                }
              />
            )}
            <Pagination page={page} setPage={setPage} total={filtered.length} />
            <div className="table-note">
              <ShieldCheck size={13} />
              Starter products have no prices or stock. You’re always in control of what gets sold.
            </div>
          </>
        )}
      </Panel>
      {edit !== undefined && (
        <ProductForm
          product={edit ?? undefined}
          onClose={() => setEdit(undefined)}
          onSaved={() => {
            setEdit(undefined);
            q.refresh();
          }}
        />
      )}
    </>
  );
}
