import DocumentLink from '../components/DocumentLink';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Plus,
  Truck,
  Users,
  Clock3,
  Wallet,
  ShieldCheck,
  ArrowUpRight,
  RotateCcw,
  FileText,
  Check,
} from 'lucide-react';
import { api, type Row, money, dateLabel, numeric } from '../lib/api';
import { useQuery, useAuth, useAction } from '../lib/state';
import {
  Button,
  Badge,
  PageHeader,
  Panel,
  SearchBox,
  Tabs,
  Pagination,
  Empty,
  ErrorState,
  Loading,
  Modal,
  Notice,
  Field,
  Input,
  MoneyInput,
  Status,
} from '../components/ui';
import { PurchaseForm, SupplierForm } from '../components/forms';
import { CorrectionModal } from '../components/CorrectionModal';
function PurchaseDetail({
  id,
  onClose,
  onCorrection,
  onUpdated,
  onPaymentCorrection,
  onReplacement,
}: {
  id: string;
  onClose: () => void;
  onCorrection: () => void;
  onUpdated: () => void;
  onPaymentCorrection: (id: string) => void;
  onReplacement: (record: Row) => void;
}) {
  const q = useQuery(`/purchases/${id}`),
    auth = useAuth(),
    a = useAction();
  const [pay, setPay] = useState(false),
    [amount, setAmount] = useState(''),
    [method, setMethod] = useState('Bank'),
    [reference, setReference] = useState('');
  if (q.loading)
    return (
      <Modal title="Purchase details" onClose={onClose}>
        <Loading />
      </Modal>
    );
  if (!q.data)
    return (
      <Modal title="Purchase details" onClose={onClose}>
        <ErrorState error={q.error} retry={q.refresh} />
      </Modal>
    );
  const d = q.data;
  const paid =
      d.payments.reduce((s: number, p: Row) => s + p.amount_cents, 0) -
      (d.payment_reversals ?? []).reduce((s: number, p: Row) => s + p.amount_cents, 0) -
      (d.refunds ?? []).reduce((s: number, p: Row) => s + p.amount_cents, 0),
    outstanding = d.reversal ? 0 : d.purchase.total_cents - paid;
  return (
    <Modal
      title="Purchase details"
      description={`${d.purchase.ref} · ${d.purchase.supplier_name}`}
      onClose={onClose}
      wide
    >
      <div className="stack">
        <div className="detail-grid">
          <div>
            <label>TOTAL PURCHASE</label>
            <strong>{money(d.purchase.total_cents, true)}</strong>
          </div>
          <div>
            <label>OUTSTANDING</label>
            <strong>{money(outstanding, true)}</strong>
          </div>
          <div>
            <label>RECEIVING STATUS</label>
            <Status
              status={
                d.reversal ? 'reversed' : d.receipt ? 'posted' : (d.receiving_request?.status ?? 'pending')
              }
            />
          </div>
        </div>
        {d.purchase.input_tax_cents > 0 && (
          <Notice>
            Inventory valuation cost: {money(d.purchase.total_cents - d.purchase.input_tax_cents, true)} ·
            Recoverable input VAT recorded: {money(d.purchase.input_tax_cents, true)}. Deductibility requires
            accountant verification.
          </Notice>
        )}
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Quantity</th>
                <th>Recorded cost</th>
                <th>Total cost</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((i: Row) => (
                <tr key={i.id}>
                  <td>
                    <strong>{i.product_name}</strong>
                  </td>
                  <td>{i.quantity}</td>
                  <td>{money(i.cost_cents, true)}</td>
                  <td>{money(i.total_cents, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="detail-grid">
          <div>
            <label>INVOICE</label>
            <strong>{d.purchase.invoice_ref}</strong>
          </div>
          <div>
            <label>INVOICE DATE</label>
            <strong>{dateLabel(d.purchase.purchase_date)}</strong>
          </div>
          <div>
            <label>PAYMENT METHOD</label>
            <strong>{d.purchase.payment_method}</strong>
          </div>
        </div>
        {d.purchase.document_id && (
          <DocumentLink className="text-button" id={d.purchase.document_id}>
            <FileText size={15} />
            View supplier invoice
          </DocumentLink>
        )}
        {!d.receipt && (
          <Notice>
            Stock has not moved yet. An administrator must approve this receipt in the approval centre.
          </Notice>
        )}
        {d.payments.length > 0 && (
          <section>
            <h3 className="form-subtitle">Supplier payment history</h3>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Method / reference</th>
                  <th>Amount</th>
                  <th>Date</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {d.payments.map((p: Row) => {
                  const reversed = (d.payment_reversals ?? []).some((r: Row) => r.payment_id === p.id);
                  return (
                    <tr key={p.id}>
                      <td>
                        {p.method}
                        <small className="cell-sub mono">{p.reference}</small>
                      </td>
                      <td>
                        {money(p.amount_cents, true)}
                        {reversed && <Badge tone="amber">Reversed</Badge>}
                      </td>
                      <td>{dateLabel(p.created_at, true)}</td>
                      <td>
                        {auth.can('expenses.create') && !reversed && !d.reversal && (
                          <button className="text-button" onClick={() => onPaymentCorrection(p.id)}>
                            Request correction
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        )}
        {pay && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void a.run(async () => {
                await api(`/purchases/${id}/payments`, {
                  method: 'POST',
                  body: { amount, method, reference },
                });
                setPay(false);
                q.refresh();
                onUpdated();
              }, 'Supplier payment recorded.');
            }}
          >
            <Notice>
              Record an already-confirmed payment. This does not transfer funds. A cash payment uses your
              current open register.
            </Notice>
            <div className="grid-2">
              <Field label="Payment amount" required>
                <MoneyInput value={amount} onChange={setAmount} label="Supplier payment amount" required />
              </Field>
              <Field label="Payment method">
                <select value={method} onChange={(e) => setMethod(e.target.value)}>
                  {['Cash', 'M-Pesa', 'Card', 'Bank'].map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </Field>
              <Field label="Payment reference" required className="span-2">
                <Input
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  minLength={3}
                  required
                />
              </Field>
            </div>
            <Button type="submit" busy={a.busy}>
              <Check size={15} />
              Record payment
            </Button>
          </form>
        )}
        {a.error && <p className="form-error">{a.error}</p>}
        {d.replacements?.length > 0 && (
          <Notice>
            Linked replacement: {d.replacements.map((p: Row) => p.ref).join(', ')}. The original stays
            preserved.
          </Notice>
        )}
        <div className="form-footer">
          {!d.replacements?.length && (d.reversal || d.receiving_request?.status === 'rejected') && (
            <Button variant="secondary" onClick={() => onReplacement(d)}>
              <RotateCcw size={14} />
              Create linked replacement
            </Button>
          )}
          {d.receipt && !d.reversal && (
            <Button variant="secondary" onClick={onCorrection}>
              <RotateCcw size={14} />
              Request reversal
            </Button>
          )}
          {d.receipt && !d.reversal && outstanding > 0 && auth.can('expenses.create') && !pay && (
            <Button
              onClick={() => {
                setAmount(numeric(outstanding));
                setPay(true);
              }}
            >
              <Wallet size={15} />
              Record supplier payment
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}
export default function Purchases() {
  const [replacement, setReplacement] = useState<{ purchase: Row; items: Row[] } | undefined>();
  const auth = useAuth(),
    [params] = useSearchParams();
  const q = useQuery('/purchases'),
    suppliersQ = useQuery('/suppliers');
  const [tab, setTab] = useState('purchases'),
    [search, setSearch] = useState(''),
    [status, setStatus] = useState(''),
    [page, setPage] = useState(1),
    [form, setForm] = useState(params.get('new') === '1'),
    [supplier, setSupplier] = useState<Row | null | undefined>(undefined),
    [backToPurchase, setBackToPurchase] = useState(false),
    [selected, setSelected] = useState<string | null>(null),
    [correction, setCorrection] = useState<{ kind: string; id: string } | null>(null);
  const purchases: Row[] = q.data?.purchases ?? [],
    suppliers: Row[] = suppliersQ.data?.suppliers ?? [];
  const filtered = purchases.filter(
    (p) =>
      `${p.ref} ${p.supplier_name} ${p.invoice_ref}`.toLowerCase().includes(search.toLowerCase()) &&
      (!status || p.status === status),
  );
  const filteredSuppliers = suppliers.filter((s) =>
    `${s.name} ${s.contact} ${s.phone} ${s.location}`.toLowerCase().includes(search.toLowerCase()),
  );
  useEffect(() => setPage(1), [search, tab, status]);
  return (
    <>
      <PageHeader
        eyebrow="GOOD STOCK. STRONG RELATIONSHIPS."
        title="Purchases & suppliers"
        description="From supplier invoice to the shelf, keep every delivery accounted for."
        actions={
          <>
            {auth.can('suppliers.write') && (
              <Button variant="secondary" onClick={() => setSupplier(null)}>
                <Plus size={15} />
                Add supplier
              </Button>
            )}
            <Button onClick={() => setForm(true)}>
              <Truck size={16} />
              Receive stock
            </Button>
          </>
        }
      />
      <div className="compact-stats">
        {[
          {
            label: 'Received purchase value',
            value: money(
              purchases.filter((p) => p.status === 'posted').reduce((s, p) => s + p.total_cents, 0),
            ),
            icon: Truck,
          },
          {
            label: 'Pending deliveries',
            value: String(purchases.filter((p) => p.status === 'pending').length),
            icon: Clock3,
          },
          {
            label: 'Supplier balance due',
            value: money(
              purchases
                .filter((p) => p.status === 'posted')
                .reduce((s, p) => s + p.total_cents - p.paid_cents, 0),
            ),
            icon: Wallet,
          },
          { label: 'Supplier relationships', value: String(suppliers.length), icon: Users },
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
            { id: 'purchases', label: 'Purchase register', count: purchases.length },
            { id: 'suppliers', label: 'Suppliers', count: suppliers.length },
          ]}
          value={tab}
          onChange={setTab}
        />
        <div className="toolbar">
          <div className="toolbar-left">
            <SearchBox
              value={search}
              onChange={setSearch}
              placeholder={tab === 'purchases' ? 'Search purchase, supplier or invoice…' : 'Find a supplier…'}
            />
          </div>
          <div className="toolbar-right">
            {tab === 'purchases' ? (
              <select
                className="select-filter"
                aria-label="Receiving status"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="">All receiving statuses</option>
                <option value="posted">Posted</option>
                <option value="pending">Pending approval</option>
                <option value="rejected">Rejected</option>
                <option value="reversed">Reversed</option>
              </select>
            ) : (
              <Badge tone="green">Audited supplier records</Badge>
            )}
          </div>
        </div>
        {(tab === 'purchases' ? q.loading : suppliersQ.loading) ? (
          <Loading />
        ) : (tab === 'purchases' ? q.error : suppliersQ.error) ? (
          <ErrorState
            error={q.error || suppliersQ.error}
            retry={() => {
              q.refresh();
              suppliersQ.refresh();
            }}
          />
        ) : tab === 'purchases' ? (
          <>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Purchase / invoice</th>
                    <th>Supplier</th>
                    <th>Items</th>
                    <th>Purchase cost</th>
                    <th>Paid</th>
                    <th>Recorded by</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice((page - 1) * 15, page * 15).map((p) => (
                    <tr key={p.id} className="clickable" onClick={() => setSelected(p.id)}>
                      <td>
                        <strong className="mono">{p.ref}</strong>
                        <small className="cell-sub">
                          {p.invoice_ref} · {dateLabel(p.purchase_date)}
                        </small>
                      </td>
                      <td>{p.supplier_name}</td>
                      <td>{p.item_count} lines</td>
                      <td className="money">{money(p.total_cents, true)}</td>
                      <td>{money(p.paid_cents, true)}</td>
                      <td>{p.staff_name}</td>
                      <td>
                        <Status status={p.status} />
                      </td>
                      <td>
                        <ArrowUpRight size={14} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!filtered.length && (
              <Empty
                icon={<Truck size={25} />}
                title="Your next delivery starts here."
                description="Create your supplier, record the invoice, and receive the stock through a controlled workflow."
                action={
                  <Button
                    onClick={() =>
                      suppliers.length
                        ? setForm(true)
                        : auth.can('suppliers.write')
                          ? setSupplier(null)
                          : setCorrection({ kind: 'supplier_change', id: '' })
                    }
                  >
                    {suppliers.length
                      ? 'Receive stock'
                      : auth.can('suppliers.write')
                        ? 'Add your first supplier'
                        : 'Request a supplier'}
                    <Plus size={14} />
                  </Button>
                }
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
                    <th>Supplier</th>
                    <th>Contact</th>
                    <th>Phone / email</th>
                    <th>Payment terms</th>
                    <th>Products</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filteredSuppliers.slice((page - 1) * 15, page * 15).map((s) => (
                    <tr
                      key={s.id}
                      className="clickable"
                      onClick={() =>
                        auth.can('suppliers.write')
                          ? setSupplier(s)
                          : setCorrection({ kind: 'supplier_change', id: s.id })
                      }
                    >
                      <td>
                        <strong>{s.name}</strong>
                        <small className="cell-sub">{s.location || 'Location not set'}</small>
                      </td>
                      <td>{s.contact || '—'}</td>
                      <td>
                        {s.phone || '—'}
                        <small className="cell-sub">{s.email}</small>
                      </td>
                      <td>{s.payment_terms || 'Not set'}</td>
                      <td>{s.product_count}</td>
                      <td>
                        <Status status={s.active ? 'active' : 'inactive'} />
                      </td>
                      <td>
                        <ArrowUpRight size={14} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!filteredSuppliers.length && (
              <Empty
                icon={<Users size={25} />}
                title="Build your supplier network"
                description="Supplier names and terms are maintained by your business — nothing is assumed."
              />
            )}
            <Pagination page={page} setPage={setPage} total={filteredSuppliers.length} />
          </>
        )}
        <div className="table-note">
          <ShieldCheck size={13} />
          Original invoices, receipts and payments are preserved. Corrections create linked reversals.
        </div>
      </Panel>
      {form && (
        <PurchaseForm
          replacement={replacement}
          onClose={() => {
            setForm(false);
            setReplacement(undefined);
          }}
          onSaved={() => {
            setForm(false);
            setReplacement(undefined);
            q.refresh();
          }}
          onNewSupplier={() => {
            setForm(false);
            setBackToPurchase(true);
            setSupplier(null);
          }}
        />
      )}
      {supplier !== undefined && (
        <SupplierForm
          supplier={supplier ?? undefined}
          onClose={() => {
            setSupplier(undefined);
            setBackToPurchase(false);
          }}
          onSaved={() => {
            setSupplier(undefined);
            suppliersQ.refresh();
            if (backToPurchase) {
              setForm(true);
              setBackToPurchase(false);
            }
          }}
        />
      )}
      {selected && (
        <PurchaseDetail
          key={selected}
          id={selected}
          onReplacement={(record) => {
            setSelected(null);
            setReplacement({ purchase: record.purchase, items: record.items });
            setForm(true);
          }}
          onClose={() => setSelected(null)}
          onUpdated={q.refresh}
          onCorrection={() => {
            setCorrection({ kind: 'purchase_reversal', id: selected });
            setSelected(null);
          }}
          onPaymentCorrection={(id) => {
            setSelected(null);
            setCorrection({ kind: 'supplier_payment_reversal', id });
          }}
        />
      )}
      {correction && (
        <CorrectionModal
          initialKind={correction.kind}
          entityId={correction.id}
          onClose={() => setCorrection(null)}
          onSaved={() => {
            setCorrection(null);
            q.refresh();
            suppliersQ.refresh();
          }}
        />
      )}
    </>
  );
}
