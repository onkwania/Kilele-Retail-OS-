import DocumentLink from '../components/DocumentLink';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ShieldCheck,
  Clock3,
  CheckCircle2,
  XCircle,
  MessageCircle,
  Plus,
  ArrowUpRight,
  FileText,
  Check,
  X,
  ArrowRight,
} from 'lucide-react';
import { api, type Row, dateLabel, initials, money } from '../lib/api';
import { useAuth, useQuery, useAction } from '../lib/state';
import {
  Badge,
  Button,
  Empty,
  ErrorState,
  Loading,
  Modal,
  Notice,
  PageHeader,
  Panel,
  Pagination,
  SearchBox,
  Tabs,
  Field,
  Status,
} from '../components/ui';
import { CorrectionModal, OriginalRecord, REQUEST_LABELS } from '../components/CorrectionModal';
export function ApprovalDetail({
  id,
  onClose,
  onSaved,
}: {
  id: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const q = useQuery(`/approvals/${id}`),
    auth = useAuth(),
    a = useAction(),
    navigate = useNavigate();
  const [reason, setReason] = useState(''),
    [reply, setReply] = useState('');
  if (q.loading)
    return (
      <Modal title="Approval request" onClose={onClose}>
        <Loading />
      </Modal>
    );
  if (!q.data)
    return (
      <Modal title="Approval request" onClose={onClose}>
        <ErrorState error={q.error} retry={q.refresh} />
      </Modal>
    );
  const r = q.data.request,
    own = r.user_id === auth.user!.id,
    reviewable = auth.can('approvals.review') && !own && r.status === 'pending';
  const original = JSON.parse(r.original_json),
    payload = JSON.parse(r.payload_json);
  const review = (decision: string) =>
    void a.run(
      async () => {
        await api(`/approvals/${id}/review`, { method: 'POST', body: { action: decision, reason } });
        onSaved();
      },
      decision === 'approve'
        ? 'Approved. The controlled adjustment has been posted.'
        : decision === 'reject'
          ? 'Request rejected. The original record is unchanged.'
          : 'Clarification requested.',
    );
  return (
    <Modal
      title={REQUEST_LABELS[r.kind] ?? r.kind}
      description={`${r.ref} · Submitted ${dateLabel(r.created_at, true)}`}
      onClose={() => !a.busy && onClose()}
      wide
    >
      <div className="stack">
        <div className="approval-detail-top">
          <Status status={r.status} />
          <span className="mono">{r.entity_id}</span>
          {auth.can('audit.read') && (
            <button className="text-button" onClick={() => navigate('/audit?approval=' + r.id)}>
              View audit relationship <ArrowUpRight size={13} />
            </button>
          )}
        </div>
        {own && auth.can('approvals.review') && r.status === 'pending' && (
          <Notice tone="amber">
            You submitted this request. <strong>A different administrator must review it.</strong>{' '}
            Self-approval is blocked on the server.
          </Notice>
        )}
        {r.kind === 'other' && (
          <Notice tone="amber">
            This is a human review note. Approving it will not alter money, stock or settings.
          </Notice>
        )}
        <div className="request-reason">
          <h3>What needs to change</h3>
          <strong>{r.reason}</strong>
          {r.explanation && <p>{r.explanation}</p>}
          <p>
            <b>Requested outcome:</b> {r.requested_change || REQUEST_LABELS[r.kind]}
          </p>
        </div>
        <section className="original-record-box">
          <h3>
            <ShieldCheck size={15} />
            Original record · preserved
          </h3>
          <OriginalRecord value={original} />
        </section>
        {Object.keys(payload).length > 0 && r.kind !== 'other' && (
          <section className="requested-payload">
            <h3>Requested adjustment details</h3>
            {r.kind === 'price_change' && payload.row ? (
              <div className="detail-grid">
                {[
                  ['cost', 'Buying'],
                  ['selling', 'Selling'],
                  ['wholesale', 'Wholesale'],
                  ['promo', 'Promotional'],
                ].map(([k, l]) => (
                  <div key={k}>
                    <label>{l}</label>
                    <strong>{payload.row[k] === null ? 'Price not set' : 'KES ' + payload.row[k]}</strong>
                  </div>
                ))}
              </div>
            ) : r.kind === 'closing_correction' ? (
              <Notice>
                New actual cash count: <strong>{money(payload.actual, true)}</strong>
              </Notice>
            ) : null}
            <details className="full-record">
              <summary>Inspect the exact requested payload</summary>
              <pre className="json-state">{JSON.stringify(payload, null, 2)}</pre>
            </details>
          </section>
        )}
        {r.evidence_id && (
          <DocumentLink className="btn btn-secondary" id={r.evidence_id}>
            <FileText size={16} />
            Inspect supporting evidence <ArrowUpRight size={14} />
          </DocumentLink>
        )}
        <section className="request-timeline">
          <h3>Request history</h3>
          {q.data.events.map((e: Row) => (
            <div key={e.id}>
              <span className="timeline-dot" />
              <div>
                <strong>
                  {e.user_name} <Badge>{e.action}</Badge>
                </strong>
                <small>{dateLabel(e.created_at, true)}</small>
                <p>{e.reason}</p>
              </div>
            </div>
          ))}
        </section>
        {r.status === 'clarification' && own && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void a.run(async () => {
                await api(`/approvals/${id}/reply`, { method: 'POST', body: { reason: reply } });
                onSaved();
              }, 'Clarification sent back for review.');
            }}
          >
            <Field label="Your clarification" required>
              <textarea
                minLength={5}
                required
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder="Answer the reviewer’s questions. Original request details remain unchanged."
              />
            </Field>
            <Button type="submit" busy={a.busy}>
              <MessageCircle size={15} />
              Send clarification
            </Button>
          </form>
        )}
        {reviewable && (
          <div className="review-decision">
            <Notice>
              Inspect the original and confirm any physical returns or refunds before approval. Financial
              reversals post to your live register, never to a closed historical session.
            </Notice>
            <Field label="Review / decision reason" required>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                minLength={5}
                placeholder="What did you verify, and why are you making this decision?"
              />
            </Field>
            {a.error && <p className="form-error">{a.error}</p>}
            <div className="review-actions">
              <Button
                variant="ghost"
                disabled={reason.trim().length < 5}
                busy={a.busy}
                onClick={() => review('clarify')}
              >
                <MessageCircle size={14} />
                Ask for clarification
              </Button>
              <Button
                variant="secondary"
                disabled={reason.trim().length < 5}
                busy={a.busy}
                onClick={() => review('reject')}
              >
                <X size={14} />
                Reject
              </Button>
              <Button disabled={reason.trim().length < 5} busy={a.busy} onClick={() => review('approve')}>
                <Check size={15} />
                {r.kind === 'other'
                  ? 'Approve review note'
                  : r.kind === 'daily_closing'
                    ? 'Approve closing'
                    : 'Approve & post'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
export default function Approvals() {
  const auth = useAuth(),
    q = useQuery('/approvals');
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState('pending'),
    [search, setSearch] = useState(''),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState<string | null>(params.get('id')),
    [form, setForm] = useState(false);
  const requests: Row[] = q.data?.requests ?? [];
  const counts = {
    pending: requests.filter((r) => r.status === 'pending').length,
    approved: requests.filter((r) => r.status === 'approved').length,
    rejected: requests.filter((r) => r.status === 'rejected').length,
    clarification: requests.filter((r) => r.status === 'clarification').length,
  };
  const filtered = requests.filter(
    (r) =>
      (tab === 'all' ||
        (tab === 'pending' ? ['pending', 'clarification'].includes(r.status) : r.status === tab)) &&
      `${r.ref} ${r.reason} ${r.requester_name} ${REQUEST_LABELS[r.kind] ?? r.kind}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  useEffect(() => setPage(1), [search, tab]);
  const close = () => {
    setSelected(null);
    if (params.has('id')) setParams({});
  };
  return (
    <>
      <PageHeader
        eyebrow="A SECOND PAIR OF EYES. A STRONGER BUSINESS."
        title={auth.can('approvals.review') ? 'Approval centre' : 'My requests'}
        description="Review with confidence. Keep the original. Leave a clear trail."
        actions={
          <Button onClick={() => setForm(true)}>
            <Plus size={16} />
            New request
          </Button>
        }
      />
      <div className="compact-stats">
        {[
          { label: 'Pending review', value: counts.pending, icon: Clock3 },
          { label: 'Approved', value: counts.approved, icon: CheckCircle2 },
          { label: 'Needs clarification', value: counts.clarification, icon: MessageCircle },
          { label: 'Rejected', value: counts.rejected, icon: XCircle },
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
      <Notice>
        <strong>Accountability is built in.</strong> Requests cannot be self-approved. A decision requires a
        reason, and approved financial changes create linked entries instead of rewriting history.
      </Notice>
      <Panel className="margin-top">
        <Tabs
          items={[
            { id: 'pending', label: 'Pending', count: counts.pending + counts.clarification },
            { id: 'approved', label: 'Approved', count: counts.approved },
            { id: 'rejected', label: 'Rejected', count: counts.rejected },
            { id: 'all', label: 'All requests', count: requests.length },
          ]}
          value={tab}
          onChange={setTab}
        />
        <div className="toolbar">
          <SearchBox
            value={search}
            onChange={setSearch}
            placeholder="Search request, reason or team member…"
          />
          <Badge tone="green">
            <ShieldCheck size={12} />
            Controlled approvals
          </Badge>
        </div>
        {q.loading ? (
          <Loading />
        ) : q.error ? (
          <ErrorState error={q.error} retry={q.refresh} />
        ) : (
          <>
            <div className="table-wrap">
              <table className="data-table approvals-table">
                <thead>
                  <tr>
                    <th>Request</th>
                    <th>Original record / reason</th>
                    <th>Requested by</th>
                    <th>Submitted</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice((page - 1) * 15, page * 15).map((r) => {
                    const o = JSON.parse(r.original_json),
                      reference = o.sale?.ref ?? o.ref ?? o.product ?? o.name ?? 'Review note';
                    return (
                      <tr className="clickable" key={r.id} onClick={() => setSelected(r.id)}>
                        <td>
                          <strong>{REQUEST_LABELS[r.kind] ?? r.kind}</strong>
                          <small className="cell-sub mono">{r.ref}</small>
                        </td>
                        <td>
                          <strong className="mono">{reference}</strong>
                          <small className="cell-sub truncate">{r.reason}</small>
                        </td>
                        <td>
                          <div className="inline">
                            <span className="avatar avatar-small">{initials(r.requester_name)}</span>
                            <span>
                              {r.requester_name}
                              {r.user_id === auth.user!.id && (
                                <small className="cell-sub">You submitted this</small>
                              )}
                            </span>
                          </div>
                        </td>
                        <td>{dateLabel(r.created_at, true)}</td>
                        <td>
                          <Status status={r.status} />
                        </td>
                        <td>
                          <ArrowUpRight size={15} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!filtered.length && (
              <Empty
                icon={<ShieldCheck size={27} />}
                title={
                  tab === 'pending' ? 'All clear. Nothing waiting for review.' : 'No requests in this view'
                }
                description={
                  tab === 'pending'
                    ? 'Sale corrections, stock adjustments and daily closings will arrive here for careful review.'
                    : 'Change the filters or create a request when something needs a correction.'
                }
                action={
                  <Button variant="secondary" onClick={() => setForm(true)}>
                    Create a request <ArrowRight size={14} />
                  </Button>
                }
              />
            )}
            <Pagination page={page} setPage={setPage} total={filtered.length} />
          </>
        )}
      </Panel>
      {selected && (
        <ApprovalDetail
          id={selected}
          onClose={close}
          onSaved={() => {
            close();
            q.refresh();
          }}
        />
      )}
      {form && (
        <CorrectionModal
          onClose={() => setForm(false)}
          onSaved={() => {
            setForm(false);
            q.refresh();
          }}
        />
      )}
    </>
  );
}
