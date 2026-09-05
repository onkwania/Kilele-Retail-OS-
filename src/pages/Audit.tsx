import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ShieldCheck,
  History,
  CheckCircle2,
  Fingerprint,
  ArrowUpRight,
  Download,
  LockKeyhole,
} from 'lucide-react';
import { api, type Row, dateLabel, titleCase } from '../lib/api';
import { useQuery, useAction } from '../lib/state';
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
export default function Audit() {
  const q = useQuery('/audit'),
    check = useQuery('/integrity'),
    a = useAction(),
    navigate = useNavigate(),
    [params] = useSearchParams();
  const [search, setSearch] = useState(''),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState<Row | null>(null);
  const rows: Row[] = q.data?.events ?? [],
    approval = params.get('approval');
  const filtered = rows.filter(
    (r) =>
      (!approval || r.approval_id === approval) &&
      `${r.action} ${r.user_name} ${r.entity} ${r.entity_id} ${r.reason}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  useEffect(() => setPage(1), [search, approval]);
  return (
    <>
      <PageHeader
        eyebrow="TRUST HAS A PAPER TRAIL"
        title="Audit trail"
        description="Who did what, when, and why. Original history, preserved by design."
        actions={
          <>
            <Button variant="secondary" onClick={() => navigate('/reports?type=audit')}>
              <Download size={15} />
              Export audit report
            </Button>
            <Button
              busy={a.busy}
              onClick={() =>
                void a.run(async () => {
                  const result = await api('/integrity');
                  check.setData(result);
                  if (!result.ok) throw new Error(result.errors.join('; '));
                }, 'Audit chain, stock ledger and accounting journal checks passed.')
              }
            >
              <Fingerprint size={15} />
              Verify ledger
            </Button>
          </>
        }
      />
      <div className={`audit-integrity ${check.data?.ok ? 'verified' : ''}`}>
        <span>{check.data?.ok ? <CheckCircle2 size={25} /> : <ShieldCheck size={25} />}</span>
        <div>
          <strong>
            {check.loading
              ? 'Checking accounting integrity…'
              : check.data?.ok
                ? 'Your accounting trail is intact.'
                : 'Review accounting integrity'}
          </strong>
          <p>
            {check.data?.ok
              ? 'Audit hashes verified · Stock balances match movements · Journals balance · Foreign keys intact'
              : check.error || check.data?.errors?.join('; ') || 'Run verification to inspect the database.'}
          </p>
        </div>
        <Badge tone={check.data?.ok ? 'green' : 'amber'}>
          {check.data?.ok ? 'Verified' : 'Check required'}
        </Badge>
      </div>
      <Panel>
        <div className="toolbar">
          <SearchBox
            value={search}
            onChange={setSearch}
            placeholder="Search an action, user, reference or reason…"
          />
          <Badge>
            <LockKeyhole size={12} />
            Immutable records
          </Badge>
        </div>
        {approval && (
          <div className="selection-bar">
            <span>Showing events linked to one approval</span>
            <button className="text-button" onClick={() => navigate('/audit')}>
              Show all audit events
            </button>
          </div>
        )}
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
                    <th>Event / timestamp</th>
                    <th>User / role</th>
                    <th>Action</th>
                    <th>Entity</th>
                    <th>Reason</th>
                    <th>Approval</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice((page - 1) * 15, page * 15).map((r) => (
                    <tr key={r.id} className="clickable" onClick={() => setSelected(r)}>
                      <td>
                        <strong className="mono">EVENT {String(r.seq).padStart(6, '0')}</strong>
                        <small className="cell-sub">{dateLabel(r.created_at, true)}</small>
                      </td>
                      <td>
                        {r.user_name}
                        <small className="cell-sub">{titleCase(r.role)}</small>
                      </td>
                      <td>
                        <Badge tone={r.action.includes('revers') ? 'amber' : 'neutral'}>
                          {r.action.replaceAll('.', ' · ').replaceAll('_', ' ')}
                        </Badge>
                      </td>
                      <td>
                        {r.entity.replaceAll('_', ' ')}
                        <small className="cell-sub mono truncate">{r.entity_id}</small>
                      </td>
                      <td className="truncate" title={r.reason}>
                        {r.reason}
                      </td>
                      <td>{r.approval_id ? <Badge tone="green">Linked</Badge> : '—'}</td>
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
                icon={<History size={25} />}
                title="No audit events match this view"
                description="Important actions leave a permanent event, including pricing, approvals, exports and stock movements."
              />
            )}
            <Pagination page={page} setPage={setPage} total={filtered.length} />
          </>
        )}
        <div className="table-note">
          <ShieldCheck size={14} />
          Latest 1,000 events. Export date-filtered reports for more history. No role can edit audit entries
          through this application.
        </div>
      </Panel>
      {selected && (
        <Modal
          title="Immutable audit event"
          description={`Event ${selected.seq} · ${selected.action} · ${dateLabel(selected.created_at, true)}`}
          onClose={() => setSelected(null)}
          wide
        >
          <div className="stack">
            <div className="detail-grid">
              <div>
                <label>PERFORMED BY</label>
                <strong>{selected.user_name}</strong>
                <p>{titleCase(selected.role)}</p>
              </div>
              <div>
                <label>ENTITY</label>
                <strong>{selected.entity}</strong>
                <p className="mono">{selected.entity_id}</p>
              </div>
              <div>
                <label>REASON</label>
                <strong>{selected.reason}</strong>
              </div>
            </div>
            <div className="grid-2">
              <section>
                <h3 className="form-subtitle">Before state</h3>
                <pre className="json-state">{JSON.stringify(JSON.parse(selected.before_json), null, 2)}</pre>
              </section>
              <section>
                <h3 className="form-subtitle">After state</h3>
                <pre className="json-state">{JSON.stringify(JSON.parse(selected.after_json), null, 2)}</pre>
              </section>
            </div>
            <div>
              <h3 className="form-subtitle">Chain integrity</h3>
              <div className="hash-block">
                <span>PREVIOUS SHA-256</span>
                <code>{selected.previous_hash}</code>
                <span>THIS EVENT SHA-256</span>
                <code>{selected.hash}</code>
              </div>
            </div>
            <Notice>
              Recorded device: {selected.device || 'Not available'}
              <br />
              IP: {selected.ip || 'Local operation'}
            </Notice>
            {selected.approval_id && (
              <Button variant="secondary" onClick={() => navigate('/approvals?id=' + selected.approval_id)}>
                View linked approval <ArrowUpRight size={15} />
              </Button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
