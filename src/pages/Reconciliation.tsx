import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Wallet,
  Plus,
  ShieldCheck,
  ClipboardCheck,
  ArrowRight,
  CheckCircle2,
  Scale,
  Smartphone,
  CreditCard,
  Landmark,
  RotateCcw,
  LockKeyhole,
} from 'lucide-react';
import { api, type Row, money, minor, dateLabel } from '../lib/api';
import { useQuery, useAction, useAuth } from '../lib/state';
import {
  Button,
  Badge,
  PageHeader,
  Panel,
  Field,
  MoneyInput,
  Notice,
  Empty,
  ErrorState,
  Loading,
  Modal,
  Status,
} from '../components/ui';
import { SessionForm } from '../components/forms';
import { CorrectionModal, OriginalRecord } from '../components/CorrectionModal';
export default function Reconciliation() {
  const q = useQuery('/sessions'),
    auth = useAuth(),
    a = useAction(),
    navigate = useNavigate();
  const [open, setOpen] = useState(false),
    [actual, setActual] = useState(''),
    [explanation, setExplanation] = useState(''),
    [confirm, setConfirm] = useState(false),
    [selected, setSelected] = useState<Row | null>(null),
    [correction, setCorrection] = useState<string | null>(null);
  const s = q.data?.current,
    closings: Row[] = q.data?.closings ?? [];
  const actualCents = minor(actual),
    variance = actualCents === null || !s ? null : actualCents - s.expected_cents;
  const explainRequired = variance !== null && Math.abs(variance) > (q.data?.variance_threshold_cents ?? 0);
  const close = () =>
    void a.run(async () => {
      await api(`/sessions/${s.id}/close`, { method: 'POST', body: { actual, explanation } });
      setConfirm(false);
      setActual('');
      setExplanation('');
      q.refresh();
    }, 'Register closed. Daily reconciliation submitted for review.');
  return (
    <>
      <PageHeader
        eyebrow="CLOSE THE DAY WITH CONFIDENCE"
        title="Daily closing"
        description="Count what’s in your drawer. Compare it with your books. Leave a clear explanation."
        actions={
          <>
            {s ? (
              <Button variant="secondary" onClick={() => navigate('/pos')}>
                Back to POS <ArrowRight size={15} />
              </Button>
            ) : (
              <Button onClick={() => setOpen(true)}>
                <Plus size={16} />
                Open register
              </Button>
            )}
          </>
        }
      />
      {q.loading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} retry={q.refresh} />
      ) : s ? (
        <div className="closing-layout">
          <Panel
            title={s.register}
            subtitle={`Opened ${dateLabel(s.opened_at, true)} · ${auth.user!.name}`}
            action={
              <Badge tone="green" dot>
                Session open
              </Badge>
            }
          >
            <div className="cash-ledger">
              <div>
                <span>Opening cash float</span>
                <strong>{money(s.opening_cents, true)}</strong>
              </div>
              <div>
                <span>
                  <i>+</i>Cash sales, net of refunds
                </span>
                <strong>{money(s.cash_sales_cents, true)}</strong>
              </div>
              <div>
                <span>
                  <i>−</i>Cash expenses, net of reversals
                </span>
                <strong>{money(s.cash_expenses_cents, true)}</strong>
              </div>
              <div>
                <span>
                  <i>−</i>Supplier cash payments, net of refunds
                </span>
                <strong>{money(s.cash_supplier_cents, true)}</strong>
              </div>
              <div className="cash-expected">
                <span>Expected cash in drawer</span>
                <strong>{money(s.expected_cents, true)}</strong>
              </div>
            </div>
            <div className="closing-tenders">
              <h3>Other recorded sale payments</h3>
              {[
                { label: 'M-Pesa', value: s.mpesa_cents, icon: Smartphone },
                { label: 'Card', value: s.card_cents, icon: CreditCard },
                { label: 'Bank', value: s.bank_cents, icon: Landmark },
              ].map((t) => (
                <div key={t.label}>
                  <span>
                    <t.icon size={16} />
                    {t.label}
                  </span>
                  <strong>{money(t.value, true)}</strong>
                </div>
              ))}
            </div>
            <div className="table-note">
              <ShieldCheck size={14} />
              Calculated from posted entries. These values cannot be edited.
            </div>
          </Panel>
          <Panel
            title="Count. Compare. Confirm."
            subtitle="Enter the physical cash count, not the expected figure."
          >
            <form
              className="closing-count-form"
              onSubmit={(e) => {
                e.preventDefault();
                setConfirm(true);
              }}
            >
              <Field label="Actual cash counted" required>
                <MoneyInput
                  value={actual}
                  onChange={setActual}
                  label="Actual cash counted"
                  required
                  placeholder="Enter physical cash count"
                />
              </Field>
              <div
                className={`variance-box ${variance === null ? '' : variance === 0 ? 'balanced' : variance < 0 ? 'shortage' : 'surplus'}`}
              >
                <span>{variance === 0 ? <CheckCircle2 size={23} /> : <Scale size={23} />}</span>
                <div>
                  <small>
                    {variance === null
                      ? 'CASH VARIANCE'
                      : variance === 0
                        ? 'BALANCED'
                        : variance < 0
                          ? 'SHORTAGE'
                          : 'SURPLUS'}
                  </small>
                  <strong>
                    {variance === null ? 'Waiting for your count' : money(Math.abs(variance), true)}
                  </strong>
                  <p>
                    {variance === null
                      ? 'Compare actual cash against the ledger.'
                      : variance === 0
                        ? 'Your count matches the recorded balance.'
                        : 'This is a reconciliation difference, not a finding of misconduct.'}
                  </p>
                </div>
              </div>
              <Field
                label="Closing note / variance explanation"
                required={explainRequired}
                hint={
                  explainRequired
                    ? 'An explanation is required for this variance.'
                    : 'Add context for the reviewing administrator.'
                }
              >
                <textarea
                  required={explainRequired}
                  minLength={explainRequired ? 5 : undefined}
                  value={explanation}
                  onChange={(e) => setExplanation(e.target.value)}
                  placeholder="Record anything the reviewer should know."
                />
              </Field>
              <Notice>
                <strong>Closing locks the session.</strong> A different administrator will review it. Later
                corrections create new records.
              </Notice>
              <Button
                className="full-width"
                type="submit"
                disabled={actualCents === null || !!(explainRequired && explanation.trim().length < 5)}
              >
                <LockKeyhole size={15} />
                Close & submit reconciliation
              </Button>
            </form>
          </Panel>
        </div>
      ) : (
        <Panel>
          <Empty
            icon={<Wallet size={28} />}
            title="Your register is resting."
            description="Open a new session with a counted cash float before processing sales. Closed sessions remain permanently preserved."
            action={
              <Button onClick={() => setOpen(true)}>
                <Plus size={15} />
                Open your register
              </Button>
            }
          />
        </Panel>
      )}
      <Panel
        className="margin-top"
        title="Closing history"
        subtitle="Original counts, explanations and review status — all preserved."
      >
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Closing reference</th>
                <th>Staff member</th>
                <th>Expected cash</th>
                <th>Latest actual</th>
                <th>Variance</th>
                <th>Review</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {closings.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => setSelected(r)}>
                  <td>
                    <strong className="mono">{r.ref}</strong>
                    <small className="cell-sub">{dateLabel(r.created_at, true)}</small>
                  </td>
                  <td>{r.staff_name}</td>
                  <td>{money(r.expected_cents, true)}</td>
                  <td>{money(r.current_actual_cents ?? r.actual_cents, true)}</td>
                  <td>
                    <Badge tone={(r.current_variance_cents ?? r.variance_cents) === 0 ? 'green' : 'amber'}>
                      {money(r.current_variance_cents ?? r.variance_cents, true)}
                    </Badge>
                  </td>
                  <td>
                    <Status status={r.status ?? 'pending'} />
                  </td>
                  <td>
                    <ArrowRight size={14} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!closings.length && (
          <Empty
            compact
            icon={<ClipboardCheck size={23} />}
            title="No daily closings yet"
            description="Each closed register will appear here with a permanent snapshot."
          />
        )}
      </Panel>
      {open && (
        <SessionForm
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            q.refresh();
          }}
        />
      )}
      {confirm && (
        <Modal
          title="Close this cash session?"
          description="Check that all sales and cash expenses have been recorded first."
          onClose={() => !a.busy && setConfirm(false)}
        >
          <div className="stack">
            <div className="detail-grid">
              <div>
                <label>EXPECTED</label>
                <strong>{money(s.expected_cents, true)}</strong>
              </div>
              <div>
                <label>ACTUAL</label>
                <strong>{money(actualCents, true)}</strong>
              </div>
              <div>
                <label>VARIANCE</label>
                <strong>{money(variance, true)}</strong>
              </div>
            </div>
            <Notice>
              This session cannot be reopened. The closing will be submitted for independent review, not
              automatically approved.
            </Notice>
            {a.error && <p className="form-error">{a.error}</p>}
            <div className="form-footer">
              <Button variant="ghost" onClick={() => setConfirm(false)} disabled={a.busy}>
                Keep session open
              </Button>
              <Button onClick={close} busy={a.busy}>
                <CheckCircle2 size={15} />
                Confirm & close register
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {selected && (
        <Modal
          title="Preserved daily closing"
          description={selected.ref}
          onClose={() => setSelected(null)}
          wide
        >
          <div className="stack">
            <OriginalRecord value={selected} />
            <div className="form-footer">
              <Button
                variant="secondary"
                onClick={() => {
                  setCorrection(selected.id);
                  setSelected(null);
                }}
              >
                <RotateCcw size={14} />
                Request count correction
              </Button>
              <Button onClick={() => navigate('/approvals?id=' + selected.request_id)}>
                Inspect approval <ArrowRight size={14} />
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {correction && (
        <CorrectionModal
          initialKind="closing_correction"
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
