import DocumentLink from '../components/DocumentLink';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  Download,
  Wallet,
  ReceiptText,
  ShieldCheck,
  RotateCcw,
  FileText,
  ArrowUpRight,
} from 'lucide-react';
import { type Row, money, dateLabel } from '../lib/api';
import { useQuery, useAuth } from '../lib/state';
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
  Status,
} from '../components/ui';
import { ExpenseForm, EXPENSE_CATEGORIES } from '../components/forms';
import { CorrectionModal, OriginalRecord } from '../components/CorrectionModal';
export default function Expenses() {
  const q = useQuery('/expenses'),
    auth = useAuth(),
    navigate = useNavigate();
  const [search, setSearch] = useState(''),
    [category, setCategory] = useState(''),
    [method, setMethod] = useState(''),
    [page, setPage] = useState(1),
    [form, setForm] = useState(false),
    [selected, setSelected] = useState<Row | null>(null),
    [correction, setCorrection] = useState<string | null>(null);
  const rows: Row[] = q.data?.expenses ?? [];
  const active = rows.filter((e) => e.status === 'posted');
  const filtered = rows.filter(
    (e) =>
      `${e.ref} ${e.description} ${e.payee} ${e.staff_name}`.toLowerCase().includes(search.toLowerCase()) &&
      (!category || e.category === category) &&
      (!method || e.method === method),
  );
  useEffect(() => setPage(1), [search, category, method]);
  return (
    <>
      <PageHeader
        eyebrow="THE COST OF DOING GOOD BUSINESS"
        title="Business expenses"
        description="Keep the day-to-day spending visible, organised and accountable."
        actions={
          <>
            <Button variant="secondary" onClick={() => navigate('/reports?type=expenses')}>
              <Download size={15} />
              Expense report
            </Button>
            {auth.can('expenses.create') && (
              <Button onClick={() => setForm(true)}>
                <Plus size={16} />
                Record expense
              </Button>
            )}
          </>
        }
      />
      <div className="compact-stats">
        {[
          {
            label: 'Net recent expenses',
            value: money(active.reduce((s, e) => s + e.amount_cents, 0)),
            icon: Wallet,
          },
          {
            label: 'Cash expenses',
            value: money(active.filter((e) => e.method === 'Cash').reduce((s, e) => s + e.amount_cents, 0)),
            icon: Wallet,
          },
          { label: 'Posted records', value: String(rows.length), icon: ReceiptText },
          {
            label: 'Preserved reversals',
            value: String(rows.filter((e) => e.status === 'reversed').length),
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
              placeholder="Search expenses, payees or references…"
            />
          </div>
          <div className="toolbar-right">
            <select
              className="select-filter"
              aria-label="Expense category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">All categories</option>
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
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
                    <th>Expense / reference</th>
                    <th>Category</th>
                    <th>Payee</th>
                    <th>Amount</th>
                    <th>Payment</th>
                    <th>Recorded by</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice((page - 1) * 15, page * 15).map((e) => (
                    <tr className="clickable" key={e.id} onClick={() => setSelected(e)}>
                      <td>
                        <strong>
                          {e.description.length > 45 ? e.description.slice(0, 45) + '…' : e.description}
                        </strong>
                        <small className="cell-sub mono">
                          {e.ref} · {dateLabel(e.expense_date)}
                        </small>
                      </td>
                      <td>
                        <Badge>{e.category}</Badge>
                      </td>
                      <td>{e.payee || '—'}</td>
                      <td className="money">{money(e.amount_cents, true)}</td>
                      <td>
                        <Badge tone={e.method === 'M-Pesa' ? 'green' : 'neutral'}>{e.method}</Badge>
                      </td>
                      <td>{e.staff_name}</td>
                      <td>
                        <Status status={e.status} />
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
                icon={<Wallet size={25} />}
                title={rows.length ? 'No matching expenses' : 'A clear view of your spending starts here.'}
                description="Record rent, deliveries, utilities and other business costs, with receipts and references attached."
                action={
                  auth.can('expenses.create') ? (
                    <Button onClick={() => setForm(true)}>
                      <Plus size={15} />
                      Record your first expense
                    </Button>
                  ) : undefined
                }
              />
            )}
            <Pagination page={page} setPage={setPage} total={filtered.length} />
          </>
        )}
        <div className="table-note">
          <ShieldCheck size={13} />
          Showing recent records. Use reports for date-based totals. Posted expenses cannot be edited or
          deleted.
        </div>
      </Panel>
      {form && (
        <ExpenseForm
          onClose={() => setForm(false)}
          onSaved={() => {
            setForm(false);
            q.refresh();
          }}
        />
      )}
      {selected && (
        <Modal
          title="Expense record"
          description={`${selected.ref} · ${dateLabel(selected.created_at, true)}`}
          onClose={() => setSelected(null)}
          wide
        >
          <div className="stack">
            <OriginalRecord value={selected} />
            {selected.document_id && (
              <DocumentLink className="btn btn-secondary" id={selected.document_id}>
                <FileText size={16} />
                View supporting receipt
              </DocumentLink>
            )}
            {selected.reversal_ref && (
              <Notice>
                Reversed by entry <strong>{selected.reversal_ref}</strong>. This original remains preserved.
              </Notice>
            )}
            <div className="form-footer">
              <Button variant="ghost" onClick={() => setSelected(null)}>
                Close
              </Button>
              {selected.status !== 'reversed' && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setCorrection(selected.id);
                    setSelected(null);
                  }}
                >
                  <RotateCcw size={15} />
                  Request correction
                </Button>
              )}
            </div>
          </div>
        </Modal>
      )}
      {correction && (
        <CorrectionModal
          initialKind="expense_reversal"
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
