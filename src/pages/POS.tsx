import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  ScanBarcode,
  ShoppingBag,
  Plus,
  Minus,
  X,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Wallet,
  Smartphone,
  CreditCard,
  Landmark,
  Layers,
  Download,
  Printer,
  ShieldCheck,
  UserRound,
  SlidersHorizontal,
  Tag,
  Package,
  Trash2,
} from 'lucide-react';
import {
  api,
  download,
  openDocument,
  type Product,
  type Row,
  money,
  numeric,
  minor,
  dateLabel,
  isReady,
  getPendingSale,
} from '../lib/api';
import { useAuth, useQuery, useAction, useToast } from '../lib/state';
import {
  Badge,
  Button,
  IconButton,
  Input,
  Field,
  MoneyInput,
  SearchBox,
  Modal,
  Notice,
  ProductGlyph,
  CategoryIcon,
  Empty,
  Loading,
  ErrorState,
} from '../components/ui';
import CheckoutRecovery from '../components/CheckoutRecovery';
import { SessionForm } from '../components/forms';
export type CartLine = { product_id: string; quantity: number; price_type: string; version: number };
export function ReceiptModal({ saleId, onClose }: { saleId: string; onClose: () => void }) {
  const q = useQuery(`/sales/${saleId}`),
    auth = useAuth(),
    a = useAction();
  return (
    <Modal
      title="Sale completed"
      description="Your sale, payments and stock movements have been safely recorded."
      onClose={onClose}
    >
      {q.loading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} retry={q.refresh} />
      ) : (
        q.data && (
          <>
            <div className="receipt-success">
              <span>
                <CheckCircle2 size={30} />
              </span>
              <strong>{money(q.data.sale.total_cents, true)}</strong>
              <Badge tone="green">Payment recorded</Badge>
            </div>
            <div className="receipt-paper">
              <h3>{auth.business?.name}</h3>
              <p>{auth.branch?.name} · Kenya</p>
              <div className="receipt-ref">{q.data.sale.ref}</div>
              <div className="receipt-meta">
                <span>{dateLabel(q.data.sale.created_at, true)}</span>
                <span>{q.data.sale.staff_name}</span>
              </div>
              {q.data.items.map((i: Row) => (
                <div className="receipt-item" key={i.id}>
                  <div>
                    <strong>{i.product_name}</strong>
                    <small>
                      {i.quantity} × {money(i.unit_price_cents)} · {i.size}
                    </small>
                  </div>
                  <span>{money(i.total_cents)}</span>
                </div>
              ))}
              <div className="receipt-summary">
                <div>
                  <span>Subtotal</span>
                  <span>{money(q.data.sale.subtotal_cents, true)}</span>
                </div>
                {q.data.sale.discount_cents > 0 && (
                  <div>
                    <span>Discount</span>
                    <span>−{money(q.data.sale.discount_cents, true)}</span>
                  </div>
                )}
                <div>
                  <span>Tax included</span>
                  <span>{money(q.data.sale.tax_cents, true)}</span>
                </div>
                <div className="receipt-grand">
                  <strong>Total</strong>
                  <strong>{money(q.data.sale.total_cents, true)}</strong>
                </div>
              </div>
              {q.data.payments.map((p: Row) => (
                <div className="receipt-tender" key={p.id}>
                  <span>
                    {p.reversal_id ? 'Refund · ' : ''}
                    {p.method}
                    <small>{p.reference}</small>
                  </span>
                  <span>
                    {money(p.amount_cents, true)}
                    {p.change_cents > 0 && <small>Change {money(p.change_cents, true)}</small>}
                  </span>
                </div>
              ))}
              <p className="receipt-thanks">{auth.business?.receipt_footer}</p>
              <small className="receipt-tax-note">Internal sales receipt · Not an eTIMS fiscal invoice</small>
            </div>
            <div className="receipt-actions">
              <Button
                variant="secondary"
                busy={a.busy}
                onClick={() =>
                  void a.run(() => download(`/sales/${saleId}/receipt`, `receipt-${q.data!.sale.ref}.pdf`))
                }
              >
                <Download size={15} />
                Download PDF
              </Button>
              <Button
                variant="secondary"
                onClick={() => void a.run(() => openDocument(`/sales/${saleId}/receipt`))}
              >
                <Printer size={15} />
                Print / view receipt
              </Button>
            </div>
            <Button className="full-width margin-top" onClick={onClose}>
              Next customer <ArrowRight size={15} />
            </Button>
          </>
        )
      )}
    </Modal>
  );
}
const paymentIcons = { Cash: Wallet, 'M-Pesa': Smartphone, Card: CreditCard, Bank: Landmark, Mixed: Layers };
function PaymentModal({
  cart,
  quote,
  sessionId,
  discount,
  discountReason,
  onClose,
  onComplete,
}: {
  cart: CartLine[];
  quote: Row;
  sessionId: string;
  discount: string;
  discountReason: string;
  onClose: () => void;
  onComplete: (id: string) => void;
}) {
  const a = useAction();
  const key = useRef(crypto.randomUUID());
  const [method, setMethod] = useState('Cash'),
    [tendered, setTendered] = useState(''),
    [reference, setReference] = useState(''),
    [age, setAge] = useState(false),
    [confirmed, setConfirmed] = useState(false);
  const [parts, setParts] = useState([
    { method: 'Cash', amount: '', reference: '', tendered: '' },
    { method: 'M-Pesa', amount: '', reference: '', tendered: '' },
  ]);
  const due = quote.total_cents;
  const mixedTotal = parts.reduce((s, p) => s + (minor(p.amount) ?? 0), 0);
  const alcohol = quote.items.some((i: Row) =>
    ['Spirits', 'Wines', 'Beer & Cider'].includes(i.category_name),
  );
  const payments =
    method === 'Mixed'
      ? parts.map((p) => ({
          method: p.method,
          amount: p.amount,
          reference: p.reference,
          ...(p.method === 'Cash' && p.tendered ? { tendered: p.tendered } : {}),
        }))
      : [
          {
            method,
            amount: numeric(due),
            reference: method === 'Cash' ? '' : reference,
            ...(method === 'Cash' ? { tendered: tendered || '0' } : {}),
          },
        ];
  const payable =
    method === 'Mixed'
      ? mixedTotal === due &&
        parts.every(
          (p) => (minor(p.amount) ?? 0) > 0 && (p.method === 'Cash' || p.reference.trim().length >= 3),
        )
      : method === 'Cash'
        ? (minor(tendered) ?? 0) >= due
        : reference.trim().length >= 3;
  return (
    <Modal
      title="Take payment"
      description="Confirm the tender, complete the sale, and keep the queue moving."
      onClose={() => !a.busy && onClose()}
      wide
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(async () => {
            const result = await api('/sales', {
              method: 'POST',
              key: key.current,
              body: {
                session_id: sessionId,
                items: cart,
                discount: discount || '0',
                discount_reason: discountReason,
                expected_total: numeric(due),
                payments,
                notes: alcohol ? 'Cashier confirmed customer is 18 or over.' : '',
              },
            });
            onComplete(result.id);
          }, 'Sale completed.');
        }}
      >
        <div className="payment-amount">
          <small>AMOUNT TO COLLECT</small>
          <strong>{money(due, true)}</strong>
          <span>{cart.reduce((s, i) => s + i.quantity, 0)} items · Prices confirmed by the server</span>
        </div>
        <div className="payment-methods">
          {Object.entries(paymentIcons).map(([name, Icon]) => (
            <button
              type="button"
              key={name}
              className={method === name ? 'active' : ''}
              onClick={() => {
                setMethod(name);
                setConfirmed(false);
              }}
            >
              <Icon size={20} />
              <span>{name === 'Mixed' ? 'Split payment' : name}</span>
              {method === name && <Check size={12} />}
            </button>
          ))}
        </div>
        {method === 'Mixed' ? (
          <div className="split-payments">
            {parts.map((p, index) => (
              <div key={index}>
                <Field label={`Payment ${index + 1}`}>
                  <select
                    value={p.method}
                    onChange={(e) =>
                      setParts((old) =>
                        old.map((v, i) => (i === index ? { ...v, method: e.target.value } : v)),
                      )
                    }
                  >
                    {['Cash', 'M-Pesa', 'Card', 'Bank'].map((m) => (
                      <option key={m} disabled={parts.some((part, i) => i !== index && part.method === m)}>
                        {m}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Amount" required>
                  <MoneyInput
                    required
                    label={`Payment ${index + 1} amount`}
                    value={p.amount}
                    onChange={(v) =>
                      setParts((old) => old.map((r, i) => (i === index ? { ...r, amount: v } : r)))
                    }
                  />
                </Field>
                <Field
                  label={p.method === 'Cash' ? 'Cash tendered (optional)' : 'Transaction reference'}
                  required={p.method !== 'Cash'}
                >
                  <Input
                    required={p.method !== 'Cash'}
                    value={p.method === 'Cash' ? p.tendered : p.reference}
                    onChange={(e) =>
                      setParts((old) =>
                        old.map((r, i) =>
                          i === index
                            ? { ...r, [p.method === 'Cash' ? 'tendered' : 'reference']: e.target.value }
                            : r,
                        ),
                      )
                    }
                    placeholder={p.method === 'Cash' ? 'Same as amount' : 'Confirmed payment reference'}
                  />
                </Field>
                {parts.length > 2 && (
                  <IconButton
                    type="button"
                    label="Remove unposted tender"
                    onClick={() => setParts(parts.filter((_, i) => i !== index))}
                  >
                    <X size={15} />
                  </IconButton>
                )}
              </div>
            ))}
            {parts.length < 4 && (
              <button
                type="button"
                className="text-button margin-top"
                onClick={() =>
                  setParts((old) => [
                    ...old,
                    {
                      method: ['Cash', 'M-Pesa', 'Card', 'Bank'].find(
                        (m) => !old.some((p) => p.method === m),
                      )!,
                      amount: '',
                      reference: '',
                      tendered: '',
                    },
                  ])
                }
              >
                <Plus size={14} />
                Add payment method
              </button>
            )}
            <div className="payment-remaining">
              <span>{mixedTotal === due ? 'Payments balanced' : 'Remaining to allocate'}</span>
              <strong className={mixedTotal > due ? 'negative' : ''}>{money(due - mixedTotal, true)}</strong>
            </div>
          </div>
        ) : method === 'Cash' ? (
          <div className="cash-payment">
            <Field label="Cash tendered" required>
              <MoneyInput
                required
                value={tendered}
                onChange={setTendered}
                label="Cash tendered"
                placeholder="Count and enter received cash"
              />
            </Field>
            <div className="cash-change">
              <span>Change to give</span>
              <strong>{money(Math.max(0, (minor(tendered) ?? 0) - due), true)}</strong>
            </div>
            <button type="button" className="text-button" onClick={() => setTendered(numeric(due))}>
              Exact amount received
            </button>
          </div>
        ) : (
          <div className="stack">
            <Notice tone="amber">
              This records a payment; it does not initiate or verify a transfer. Confirm funds on your{' '}
              {method === 'M-Pesa'
                ? 'M-Pesa till statement'
                : method === 'Card'
                  ? 'card terminal'
                  : 'bank statement'}{' '}
              before continuing.
            </Notice>
            <Field
              label={
                method === 'M-Pesa'
                  ? 'M-Pesa transaction code'
                  : method === 'Card'
                    ? 'Terminal / approval reference'
                    : 'Bank transaction reference'
              }
              required
              hint={method === 'Card' ? 'Never enter or store a full card number or CVV.' : undefined}
            >
              <Input
                required
                minLength={3}
                maxLength={100}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Enter the confirmed reference"
              />
            </Field>
          </div>
        )}
        <div className="payment-checks">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              required
            />
            I have counted the cash and/or verified all electronic payments.
          </label>
          {alcohol && (
            <label className="checkbox-label">
              <input type="checkbox" checked={age} onChange={(e) => setAge(e.target.checked)} required />I
              have confirmed the customer is 18 years or older.
            </label>
          )}
        </div>
        {a.error && <Notice tone="error">{a.error}</Notice>}
        <div className="form-footer">
          <Button variant="ghost" type="button" onClick={onClose} disabled={a.busy}>
            Back to order
          </Button>
          <Button type="submit" busy={a.busy} disabled={!payable || !confirmed || (alcohol && !age)}>
            <CheckCircle2 size={16} />
            Complete sale · {money(due)}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
export default function POS() {
  const [pending, setPending] = useState(getPendingSale),
    [recover, setRecover] = useState(false);
  useEffect(() => {
    const update = () => setPending(getPendingSale());
    window.addEventListener('submission-state-changed', update);
    return () => window.removeEventListener('submission-state-changed', update);
  }, []);
  const auth = useAuth(),
    navigate = useNavigate(),
    toast = useToast();
  const productsQ = useQuery<{ products: Product[] }>('/products'),
    sessionQ = useQuery('/workspace/summary');
  const [search, setSearch] = useState(''),
    [category, setCategory] = useState('All'),
    [onlyReady, setOnlyReady] = useState(false),
    [cart, setCart] = useState<CartLine[]>([]),
    [discount, setDiscount] = useState('0'),
    [discountReason, setDiscountReason] = useState(''),
    [showDiscount, setShowDiscount] = useState(false),
    [quote, setQuote] = useState<Row | null>(null),
    [quoteLoading, setQuoteLoading] = useState(false),
    [quoteError, setQuoteError] = useState(''),
    [sessionForm, setSessionForm] = useState(false),
    [payment, setPayment] = useState(false),
    [receipt, setReceipt] = useState<string | null>(null),
    [clear, setClear] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const products = productsQ.data?.products ?? [],
    session = sessionQ.data?.session;
  const filtered = products.filter(
    (p) =>
      p.active &&
      (category === 'All' || p.category === category) &&
      (!onlyReady || isReady(p)) &&
      `${p.name} ${p.sku} ${p.barcode ?? ''} ${p.brand}`.toLowerCase().includes(search.toLowerCase()),
  );
  useEffect(() => {
    searchRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!cart.length) {
      setQuote(null);
      setQuoteError('');
      return;
    }
    setQuoteLoading(true);
    const abort = new AbortController();
    const timer = setTimeout(
      () =>
        api('/sales/quote', {
          method: 'POST',
          body: { items: cart, discount: discount || '0', discount_reason: discountReason },
          signal: abort.signal,
        })
          .then((q) => {
            setQuote(q);
            setQuoteError('');
            setQuoteLoading(false);
          })
          .catch((e) => {
            if (e.name !== 'AbortError') {
              setQuoteError(e.message);
              setQuote(null);
              setQuoteLoading(false);
            }
          }),
      180,
    );
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [cart, discount, discountReason]);
  const add = (p: Product) => {
    if (pending) {
      toast('Resolve the saved checkout before starting another sale.', 'error');
      setRecover(true);
      return;
    }
    if (!isReady(p)) {
      toast(
        p.selling_cents === null || p.cost_configured === 0
          ? `${p.name}: price not set. Ask an administrator to configure it.`
          : p.tax_mode === 'unset'
            ? `${p.name}: tax treatment needs to be confirmed.`
            : p.stock === 0
              ? `${p.name} is out of stock.`
              : 'Confirm package size before selling.',
        'info',
      );
      return;
    }
    const existing = cart.find((i) => i.product_id === p.id);
    if ((existing?.quantity ?? 0) >= p.stock) {
      toast(`Only ${p.stock} units are available.`, 'error');
      return;
    }
    setCart((old) =>
      existing
        ? old.map((i) => (i.product_id === p.id ? { ...i, quantity: i.quantity + 1 } : i))
        : [
            ...old,
            {
              product_id: p.id,
              quantity: 1,
              price_type: p.promo_cents !== null ? 'promo' : 'retail',
              version: p.version,
            },
          ],
    );
    setSearch('');
    searchRef.current?.focus();
  };
  const scan = () => {
    const text = search.trim().toLowerCase();
    const match =
      products.find((p) => (p.barcode ?? '').toLowerCase() === text || p.sku.toLowerCase() === text) ||
      (filtered.length === 1 ? filtered[0] : null);
    if (match && text) add(match);
    else if (text) toast('No exact barcode / SKU match. Choose a product from the results.', 'info');
  };
  const updateQty = (pid: string, quantity: number) => {
    const p = products.find((p) => p.id === pid)!;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > p.stock) {
      toast(`Quantity must be between 1 and ${p.stock}.`, 'info');
      return;
    }
    setCart((old) => old.map((i) => (i.product_id === pid ? { ...i, quantity } : i)));
  };
  const categories = [...new Set(products.map((p) => p.category))];
  const noSetup = products.length > 0 && !products.some(isReady);
  return (
    <div className="pos-page">
      <div className="pos-heading">
        <div>
          <div className="eyebrow">A GOOD SALE STARTS WITH A SIMPLE FLOW</div>
          <h1>Point of sale</h1>
          <p>Scan. Select. Sell. You’ve got this.</p>
        </div>
        <button
          className={`session-pill ${session ? 'open' : ''}`}
          onClick={() => (session ? navigate('/reconciliation') : setSessionForm(true))}
        >
          <span />
          {session ? session.register : 'Register closed'}
          <ArrowUpRight size={13} />
        </button>
      </div>
      <>
        {pending && (
          <div className="margin-bottom">
            <Notice tone="amber">
              <strong>A checkout is waiting for confirmation.</strong> Do not charge the customer again.{' '}
              <button className="text-button" onClick={() => setRecover(true)}>
                Resolve saved checkout
              </button>
            </Notice>
          </div>
        )}
      </>
      <div className="pos-layout">
        <section className="pos-catalogue">
          <div className="pos-search-row">
            <div className="scanner-search">
              <ScanBarcode size={23} />
              <SearchBox
                inputRef={searchRef}
                value={search}
                onChange={setSearch}
                placeholder="Scan barcode, or search product / SKU…"
                onEnter={scan}
              />
              <kbd>↵</kbd>
            </div>
            <IconButton label="Manage catalogue" onClick={() => navigate('/products')}>
              <SlidersHorizontal size={19} />
            </IconButton>
          </div>
          <div className="pos-categories">
            <button className={category === 'All' ? 'active' : ''} onClick={() => setCategory('All')}>
              <Package size={17} />
              All products
            </button>
            {categories.map((c) => (
              <button key={c} className={category === c ? 'active' : ''} onClick={() => setCategory(c)}>
                <CategoryIcon category={c} size={17} />
                {c}
              </button>
            ))}
          </div>
          {noSetup && (
            <div className="pos-setup-note">
              <Tag size={19} />
              <div>
                <strong>Your shelf is waiting for its first sale.</strong>
                <p>Configure prices, tax treatment and stock to make products sellable.</p>
              </div>
              {auth.can('prices.write') && (
                <button onClick={() => navigate('/pricing')}>
                  Set prices <ArrowRight size={13} />
                </button>
              )}
            </div>
          )}
          <div className="pos-result-caption">
            <span>
              {filtered.length} products <i>·</i> {category === 'All' ? 'Your complete catalogue' : category}
            </span>
            <label className="checkbox-label">
              <input type="checkbox" checked={onlyReady} onChange={(e) => setOnlyReady(e.target.checked)} />
              Ready to sell only
            </label>
          </div>
          {productsQ.loading ? (
            <Loading label="Getting your shelf ready…" />
          ) : productsQ.error ? (
            <ErrorState error={productsQ.error} retry={productsQ.refresh} />
          ) : filtered.length ? (
            <div className="pos-product-grid">
              {filtered.map((p) => (
                <button
                  key={p.id}
                  className={`pos-product ${isReady(p) ? 'ready' : 'unconfigured'}`}
                  onClick={() => add(p)}
                  title={`${p.name} · ${p.size} · ${p.sku}`}
                >
                  <div className="product-card-image">
                    <ProductGlyph product={p} large />
                    <span className={`product-stock-tag ${p.stock ? '' : 'zero'}`}>
                      {p.stock ? p.stock + ' in stock' : 'No stock'}
                    </span>
                  </div>
                  <div className="product-card-copy">
                    <small>{p.brand}</small>
                    <h3>{p.name}</h3>
                    <span>
                      {p.size} <i>·</i> {p.unit}
                    </span>
                    <footer>
                      {p.selling_cents === null ? (
                        <Badge tone="amber">Price not set</Badge>
                      ) : (
                        <strong>{money(p.promo_cents ?? p.selling_cents)}</strong>
                      )}
                      <span className="product-add">
                        <Plus size={14} />
                      </span>
                    </footer>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <Empty
              icon={<Search size={23} />}
              title="Nothing on this shelf yet"
              description="Try another search, category or availability filter."
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSearch('');
                    setCategory('All');
                    setOnlyReady(false);
                  }}
                >
                  Show all products
                </Button>
              }
            />
          )}
        </section>
        <aside className="cart-panel">
          <header>
            <div>
              <ShoppingBag size={18} />
              <h2>Current sale</h2>
              <Badge>{cart.reduce((s, i) => s + i.quantity, 0)} items</Badge>
            </div>
            <IconButton label="Clear unposted cart" disabled={!cart.length} onClick={() => setClear(true)}>
              <Trash2 size={15} />
            </IconButton>
          </header>
          <div className="cart-customer">
            <UserRound size={16} />
            <span>Walk-in customer</span>
            <Badge>Retail</Badge>
          </div>
          <div className="cart-lines">
            {!cart.length ? (
              <div className="cart-empty">
                <div className="cart-illustration">
                  <ShoppingBag size={40} strokeWidth={1} />
                  <span>+</span>
                </div>
                <h3>A new sale starts here.</h3>
                <p>
                  Scan a barcode or tap a product
                  <br />
                  to add it to this order.
                </p>
                <span className="scan-hint">
                  <ScanBarcode size={15} />
                  Your scanner is ready
                </span>
              </div>
            ) : (
              cart.map((line) => {
                const p = products.find((p) => p.id === line.product_id)!;
                const q = quote?.items.find((i: Row) => i.product_id === line.product_id);
                return (
                  <div className="cart-line" key={line.product_id}>
                    <div className="cart-line-top">
                      <ProductGlyph product={p} />
                      <div>
                        <strong>{p.name}</strong>
                        <small>
                          {p.size} · {p.unit}
                        </small>
                      </div>
                      <IconButton
                        label={`Remove ${p.name} from draft sale`}
                        onClick={() => setCart((old) => old.filter((i) => i.product_id !== line.product_id))}
                      >
                        <X size={13} />
                      </IconButton>
                    </div>
                    <div className="cart-line-bottom">
                      <div className="quantity-stepper">
                        <button
                          aria-label={`Decrease ${p.name} quantity`}
                          disabled={line.quantity <= 1}
                          onClick={() => updateQty(p.id, line.quantity - 1)}
                        >
                          <Minus size={12} />
                        </button>
                        <input
                          aria-label={`${p.name} quantity`}
                          value={line.quantity}
                          type="number"
                          min={1}
                          max={p.stock}
                          onChange={(e) => updateQty(p.id, Number(e.target.value))}
                        />
                        <button
                          aria-label={`Increase ${p.name} quantity`}
                          disabled={line.quantity >= p.stock}
                          onClick={() => updateQty(p.id, line.quantity + 1)}
                        >
                          <Plus size={12} />
                        </button>
                      </div>
                      {(p.promo_cents !== null || auth.can('sales.discount')) && (
                        <select
                          aria-label={`${p.name} price type`}
                          value={line.price_type}
                          onChange={(e) =>
                            setCart((old) =>
                              old.map((i) =>
                                i.product_id === p.id ? { ...i, price_type: e.target.value } : i,
                              ),
                            )
                          }
                        >
                          <option value="retail">Retail</option>
                          {p.promo_cents !== null && <option value="promo">Promo</option>}
                          {auth.can('sales.discount') && p.wholesale_cents !== null && (
                            <option value="wholesale">Wholesale</option>
                          )}
                        </select>
                      )}
                      <strong>{q ? money(q.total_cents) : '…'}</strong>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <div className="cart-totals">
            {quoteError && <Notice tone="error">{quoteError}</Notice>}
            {auth.can('sales.discount') && cart.length > 0 && (
              <div className="cart-discount">
                <button className="text-button" onClick={() => setShowDiscount(!showDiscount)}>
                  <Tag size={13} />
                  {showDiscount ? 'Hide discount' : 'Apply authorised discount'}
                </button>
                {showDiscount && (
                  <div className="stack">
                    <MoneyInput value={discount} onChange={setDiscount} label="Discount amount" />
                    <Input
                      value={discountReason}
                      onChange={(e) => setDiscountReason(e.target.value)}
                      placeholder="Authorisation reason (required)"
                    />
                  </div>
                )}
              </div>
            )}
            <div>
              <span>Subtotal</span>
              <span>{money(quote?.subtotal_cents ?? 0, true)}</span>
            </div>
            <div>
              <span>Discount</span>
              <span>− {money(quote?.discount_cents ?? 0, true)}</span>
            </div>
            <div>
              <span>Tax included</span>
              <span>{money(quote?.tax_cents ?? 0, true)}</span>
            </div>
            <div className="cart-grand-total">
              <span>Total</span>
              <strong>{money(quote?.total_cents ?? 0, true)}</strong>
            </div>
            {session ? (
              <Button
                className="full-width btn-lg"
                disabled={!!pending || !cart.length || !quote || quoteLoading || !!quoteError}
                onClick={() => setPayment(true)}
              >
                Take payment <ArrowRight size={17} />
              </Button>
            ) : (
              <Button className="full-width btn-lg" onClick={() => setSessionForm(true)}>
                Open register to sell <ArrowRight size={16} />
              </Button>
            )}
            <p className="cart-safety">
              <ShieldCheck size={12} />
              Secure checkout. Every sale is accounted for.
            </p>
          </div>
        </aside>
      </div>
      <button
        className="mobile-order-bar"
        onClick={() =>
          document.querySelector('.cart-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      >
        <span>
          <ShoppingBag size={16} />
          Current sale · {cart.reduce((sum, i) => sum + i.quantity, 0)} items
        </span>
        <strong>{money(quote?.total_cents ?? 0)}</strong>
        <ArrowRight size={15} />
      </button>
      {sessionForm && (
        <SessionForm
          onClose={() => setSessionForm(false)}
          onSaved={() => {
            setSessionForm(false);
            sessionQ.refresh();
          }}
        />
      )}
      {payment && quote && session && (
        <PaymentModal
          cart={cart}
          quote={quote}
          sessionId={session.id}
          discount={discount}
          discountReason={discountReason}
          onClose={() => setPayment(false)}
          onComplete={(id) => {
            setPayment(false);
            setReceipt(id);
            setCart([]);
            setDiscount('0');
            setDiscountReason('');
            setShowDiscount(false);
            productsQ.refresh();
            sessionQ.refresh();
          }}
        />
      )}
      {pending && recover && (
        <CheckoutRecovery
          pending={pending}
          onClose={() => setRecover(false)}
          onCancelled={() => {
            setRecover(false);
            setPayment(false);
            setCart([]);
            productsQ.refresh();
            sessionQ.refresh();
          }}
          onComplete={(id) => {
            setRecover(false);
            setPayment(false);
            setCart([]);
            setDiscount('');
            setDiscountReason('');
            setReceipt(id);
            productsQ.refresh();
            sessionQ.refresh();
          }}
        />
      )}
      {receipt && (
        <ReceiptModal
          saleId={receipt}
          onClose={() => {
            setReceipt(null);
            searchRef.current?.focus();
          }}
        />
      )}
      {clear && (
        <Modal
          title="Clear this draft sale?"
          description="Only the unposted cart will be cleared. No completed transactions are affected."
          onClose={() => setClear(false)}
        >
          <div className="form-footer">
            <Button variant="secondary" onClick={() => setClear(false)}>
              Keep order
            </Button>
            <Button
              onClick={() => {
                setCart([]);
                setDiscount('0');
                setDiscountReason('');
                setClear(false);
              }}
            >
              Clear draft sale
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
