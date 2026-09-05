import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  ReceiptText,
  Download,
  ShieldCheck,
  RotateCcw,
  ArrowUpRight,
  Wallet,
  ShoppingBag,
  TrendingUp,
} from 'lucide-react';
import { download, openDocument, type Row, money, dateLabel } from '../lib/api';
import { useQuery, useAuth, useAction } from '../lib/state';
import {
  Button,
  Badge,
  PageHeader,
  Panel,
  SearchBox,
  Pagination,
  Empty,
  ErrorState,
  Loading,
  Modal,
  Notice,
} from '../components/ui';
import { CorrectionModal } from '../components/CorrectionModal';
export function SaleDetail({
  id,
  onClose,
  onCorrection,
}: {
  id: string;
  onClose: () => void;
  onCorrection: () => void;
}) {
  const q = useQuery(`/sales/${id}`),
    a = useAction();
  return (
    <Modal
      title="Sale details"
      description="Completed sales are immutable. A correction creates a linked entry."
      onClose={onClose}
      wide
    >
      {q.loading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} retry={q.refresh} />
      ) : (
        q.data && (
          <>
            <div className="transaction-detail-head">
              <div>
                <small>TRANSACTION REFERENCE</small>
                <h3>{q.data.sale.ref}</h3>
                <p>
                  {dateLabel(q.data.sale.created_at, true)} · {q.data.sale.staff_name}
                </p>
              </div>
              <Badge tone="green" dot>
                Completed sale
              </Badge>
            </div>
            <div className="table-wrap margin-top">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Qty</th>
                    <th>Recorded unit price</th>
                    <th>Discount</th>
                    <th>Tax</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.items.map((i: Row) => (
                    <tr key={i.id}>
                      <td>
                        <strong>{i.product_name}</strong>
                        <small className="cell-sub">
                          {i.size} · {i.sku}
                        </small>
                      </td>
                      <td>
                        {i.quantity}
                        {i.returned_qty > 0 && <small className="cell-sub">{i.returned_qty} returned</small>}
                      </td>
                      <td>{money(i.unit_price_cents, true)}</td>
                      <td>{money(i.discount_cents, true)}</td>
                      <td>{money(i.tax_cents, true)}</td>
                      <td className="money">{money(i.total_cents, true)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="detail-grid margin-top">
              <div>
                <label>ORIGINAL TOTAL</label>
                <strong>{money(q.data.sale.total_cents, true)}</strong>
              </div>
              <div>
                <label>TAX INCLUDED</label>
                <strong>{money(q.data.sale.tax_cents, true)}</strong>
              </div>
              <div>
                <label>RECORDED COGS</label>
                <strong>
                  {q.data.sale.cogs_cents == null ? 'Restricted' : money(q.data.sale.cogs_cents, true)}
                </strong>
              </div>
            </div>
            <section className="detail-section">
              <h3>Payments & refunds</h3>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Method</th>
                      <th>Reference</th>
                      <th>Amount</th>
                      <th>Cash change</th>
                      <th>Posted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {q.data.payments.map((p: Row) => (
                      <tr key={p.id}>
                        <td>
                          <Badge tone={p.method === 'M-Pesa' ? 'green' : 'neutral'}>{p.method}</Badge>
                        </td>
                        <td className="mono">{p.reference || 'Cash tender'}</td>
                        <td className={p.amount_cents < 0 ? 'negative' : 'money'}>
                          {money(p.amount_cents, true)}
                        </td>
                        <td>{money(p.change_cents, true)}</td>
                        <td>{dateLabel(p.created_at, true)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            {q.data.reversals.length > 0 && (
              <section className="detail-section">
                <h3>Linked corrections — original sale preserved</h3>
                {q.data.reversals.map((r: Row) => (
                  <Notice key={r.id}>
                    <strong>{r.ref}</strong> · {money(r.total_cents)} reversed by {r.user_name}. {r.reason}
                  </Notice>
                ))}
              </section>
            )}
            <div className="form-footer">
              <Button variant="secondary" onClick={onCorrection}>
                <RotateCcw size={14} />
                Request correction
              </Button>
              <Button
                variant="secondary"
                busy={a.busy}
                onClick={() =>
                  void a.run(() => download(`/sales/${id}/receipt`, `receipt-${q.data!.sale.ref}.pdf`))
                }
              >
                <Download size={14} />
                Receipt PDF
              </Button>
              <Button onClick={() => void a.run(() => openDocument(`/sales/${id}/receipt`))}>
                Print / view receipt <ArrowUpRight size={14} />
              </Button>
            </div>
          </>
        )
      )}
    </Modal>
  );
}
export default function Sales() {
  const q = useQuery('/sales'),
    auth = useAuth(),
    navigate = useNavigate();
  const [search, setSearch] = useState(''),
    [method, setMethod] = useState(''),
    [status, setStatus] = useState(''),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState<string | null>(null),
    [correction, setCorrection] = useState<string | null>(null);
  const sales: Row[] = q.data?.sales ?? [];
  const current = q.data?.today ?? { transactions: 0, original_cents: 0, net_collections_cents: 0 };
  const filtered = sales.filter(
    (s) =>
      `${s.ref} ${s.staff_name}`.toLowerCase().includes(search.toLowerCase()) &&
      (!method || s.payment_methods?.includes(method)) &&
      (!status ||
        (status === 'completed' && s.refunded_cents === 0) ||
        (status === 'returned' && s.refunded_cents > 0)),
  );
  useEffect(() => setPage(1), [search, method, status]);
  return (
    <>
      <PageHeader
        eyebrow="EVERY SALE HAS A STORY"
        title="Sales & transactions"
        description="A complete record. From the first item scanned to the last shilling collected."
        actions={
          <>
            {auth.can('reports.read') && (
              <Button variant="secondary" onClick={() => navigate('/reports?type=sales')}>
                <Download size={15} />
                Export report
              </Button>
            )}
            <Button onClick={() => navigate('/pos')}>
              <Plus size={16} />
              New sale
            </Button>
          </>
        }
      />
      <div className="compact-stats">
        {[
          { label: 'Sales recorded today', value: String(current.transactions), icon: ShoppingBag },
          { label: 'Today’s net collections', value: money(current.net_collections_cents), icon: Wallet },
          {
            label: 'Average sale today',
            value: money(
              current.transactions ? Math.round(current.original_cents / current.transactions) : 0,
            ),
            icon: TrendingUp,
          },
          {
            label: 'Returned / corrected sales',
            value: String(sales.filter((s) => s.refunded_cents > 0).length),
            icon: RotateCcw,
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
        <div className="toolbar">
          <div className="toolbar-left">
            <SearchBox
              value={search}
              onChange={setSearch}
              placeholder="Find a transaction or staff member…"
            />
          </div>
          <div className="toolbar-right">
            <select
              className="select-filter"
              aria-label="Payment method"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            >
              <option value="">All payment methods</option>
              {['Cash', 'M-Pesa', 'Card', 'Bank'].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
            <select
              className="select-filter"
              aria-label="Transaction status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">All transactions</option>
              <option value="completed">Completed</option>
              <option value="returned">With returns</option>
            </select>
          </div>
        </div>
        {q.loading ? (
          <Loading />
        ) : q.error ? (
          <ErrorState error={q.error} retry={q.refresh} />
        ) : (
          <>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Transaction</th>
                    <th>Staff member</th>
                    <th>Items</th>
                    <th>Payment</th>
                    <th>Original total</th>
                    <th>Returned</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice((page - 1) * 15, page * 15).map((s) => (
                    <tr className="clickable" key={s.id} onClick={() => setSelected(s.id)}>
                      <td>
                        <strong className="mono">{s.ref}</strong>
                        <small className="cell-sub">{dateLabel(s.created_at, true)}</small>
                      </td>
                      <td>{s.staff_name}</td>
                      <td>{s.item_count} lines</td>
                      <td>
                        <div className="payment-badges">
                          {s.payment_methods?.split(',').map((m: string) => (
                            <Badge key={m} tone={m === 'M-Pesa' ? 'green' : 'neutral'}>
                              {m}
                            </Badge>
                          ))}
                        </div>
                      </td>
                      <td className="money">{money(s.total_cents, true)}</td>
                      <td>{s.refunded_cents ? money(s.refunded_cents, true) : '—'}</td>
                      <td>
                        <Badge
                          tone={
                            s.refunded_cents === s.total_cents
                              ? 'neutral'
                              : s.refunded_cents
                                ? 'amber'
                                : 'green'
                          }
                          dot
                        >
                          {s.refunded_cents === s.total_cents
                            ? 'Fully returned'
                            : s.refunded_cents
                              ? 'Part returned'
                              : 'Completed'}
                        </Badge>
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
                icon={<ReceiptText size={25} />}
                title={sales.length ? 'No matching transactions' : 'Your first sale belongs here.'}
                description="Completed sales, payment references and linked returns will appear in this secure record."
                action={
                  <Button onClick={() => navigate('/pos')}>
                    Open point of sale <ArrowRightIcon />
                  </Button>
                }
              />
            )}
            <Pagination page={page} setPage={setPage} total={filtered.length} />
            <div className="table-note">
              <ShieldCheck size={13} />
              Showing up to 2,000 recent transactions. Use Reports for date-range exports. Never delete a
              completed sale.
            </div>
          </>
        )}
      </Panel>
      {selected && (
        <SaleDetail
          id={selected}
          onClose={() => setSelected(null)}
          onCorrection={() => {
            setCorrection(selected);
            setSelected(null);
          }}
        />
      )}
      {correction && (
        <CorrectionModal
          initialKind="sale_void"
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
function ArrowRightIcon() {
  return <ArrowUpRight size={15} />;
}
