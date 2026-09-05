import { useState } from 'react';
import {
  Plus,
  Users,
  ShieldCheck,
  KeyRound,
  Check,
  UserCheck,
  ArrowUpRight,
  Eye,
  EyeOff,
} from 'lucide-react';
import { api, type Row, money, initials, roleName, today, daysAgo, queryString } from '../lib/api';
import { useQuery, useAuth, useAction } from '../lib/state';
import {
  Button,
  Badge,
  PageHeader,
  Panel,
  SearchBox,
  Field,
  Input,
  Modal,
  Notice,
  Loading,
  ErrorState,
  RangeControl,
} from '../components/ui';
function StaffForm({ user, onClose, onSaved }: { user?: Row; onClose: () => void; onSaved: () => void }) {
  const auth = useAuth(),
    a = useAction();
  const [form, setForm] = useState({
    name: user?.name ?? '',
    email: user?.email ?? '',
    role_id: user?.role_id ?? 'cashier',
    active: user ? !!user.active : true,
    reports_access: user ? (user.permissions?.includes('reports.read') ?? false) : true,
    reason: '',
    ...(!user ? { password: '' } : {}),
  });
  const [show, setShow] = useState(false);
  const set = (k: string, v: unknown) => setForm((old) => ({ ...old, [k]: v }));
  return (
    <Modal
      title={user ? 'Manage staff access' : 'Add a team member'}
      description="Access is enforced by the server. Every role change is recorded."
      onClose={onClose}
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(
            async () => {
              await api(user ? `/staff/${user.id}` : '/staff', {
                method: user ? 'PATCH' : 'POST',
                body: form,
              });
              onSaved();
            },
            user ? 'Staff access updated.' : 'Staff account created. Share the temporary password securely.',
          );
        }}
      >
        <Field label="Full name" required>
          <Input required value={form.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="Email address" required>
          <Input type="email" required value={form.email} onChange={(e) => set('email', e.target.value)} />
        </Field>
        <Field label="Role" required>
          <select value={form.role_id} onChange={(e) => set('role_id', e.target.value)}>
            {[
              'cashier',
              'accountant',
              'inventory',
              ...(auth.user!.role_id === 'super_admin' ? ['admin', 'super_admin'] : []),
            ].map((r) => (
              <option key={r} value={r}>
                {roleName(r)}
              </option>
            ))}
          </select>
        </Field>
        {form.role_id === 'accountant' && (
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={form.reports_access}
              onChange={(e) => set('reports_access', e.target.checked)}
            />
            Allow financial reports (inventory reports remain role-permitted)
          </label>
        )}
        {!user && (
          <Field
            label="Temporary password"
            required
            hint="At least 12 characters. The user must replace it at first sign-in."
          >
            <div className="password-input">
              <Input
                type={show ? 'text' : 'password'}
                minLength={12}
                maxLength={200}
                required
                value={form.password ?? ''}
                onChange={(e) => set('password', e.target.value)}
                autoComplete="new-password"
              />
              <button type="button" aria-label="Show temporary password" onClick={() => setShow(!show)}>
                {show ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </Field>
        )}
        {user && (
          <label className="checkbox-label">
            <input type="checkbox" checked={form.active} onChange={(e) => set('active', e.target.checked)} />
            Active account
          </label>
        )}
        <Field label="Reason for access change" required>
          <Input
            value={form.reason}
            minLength={5}
            required
            onChange={(e) => set('reason', e.target.value)}
            placeholder="e.g. New cashier assigned to the main register"
          />
        </Field>
        <Notice>
          Staff cannot delete accounting records, change permissions, approve their own requests or alter
          audit logs. Only super administrators manage administrator accounts.
        </Notice>
        {a.error && <p className="form-error">{a.error}</p>}
        <div className="form-footer">
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={a.busy}>
            <Check size={15} />
            {user ? 'Save access' : 'Create staff account'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
export default function Staff() {
  const auth = useAuth(),
    q = useQuery('/staff'),
    a = useAction();
  const [search, setSearch] = useState(''),
    [range, setRange] = useState({ from: daysAgo(6), to: today() }),
    [user, setUser] = useState<Row | null | undefined>(undefined),
    [permissions, setPermissions] = useState(false),
    [reset, setReset] = useState<Row | null>(null),
    [password, setPassword] = useState(''),
    [reason, setReason] = useState('');
  const performance = useQuery('/analytics/staff?' + queryString(range));
  const users: Row[] = q.data?.users ?? [];
  return (
    <>
      <PageHeader
        eyebrow="THE PEOPLE BEHIND YOUR BUSINESS"
        title="Staff & access"
        description="Clear responsibilities. Appropriate access. Performance with context."
        actions={
          <>
            <Button variant="secondary" onClick={() => setPermissions(true)}>
              <ShieldCheck size={15} />
              Role permissions
            </Button>
            {auth.can('staff.write') && (
              <Button onClick={() => setUser(null)}>
                <Plus size={16} />
                Add team member
              </Button>
            )}
          </>
        }
      />
      <div className="compact-stats">
        {[
          { label: 'Team members', value: users.length, icon: Users },
          { label: 'Active accounts', value: users.filter((u) => u.active).length, icon: UserCheck },
          {
            label: 'Independent reviewers',
            value: users.filter((u) => u.active && ['admin', 'super_admin'].includes(u.role_id)).length,
            icon: ShieldCheck,
          },
          {
            label: 'Need password change',
            value: users.filter((u) => u.must_change_password).length,
            icon: KeyRound,
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
      {users.filter((u) => u.active && ['admin', 'super_admin'].includes(u.role_id)).length < 2 && (
        <Notice tone="amber">
          <strong>Add a second trusted administrator for independent review.</strong> No user, including the
          super administrator, can approve their own correction or daily closing.
        </Notice>
      )}
      <Panel className="margin-top">
        <div className="toolbar">
          <SearchBox value={search} onChange={setSearch} placeholder="Find a team member…" />
          <RangeControl range={range} onChange={setRange} />
        </div>
        {q.loading || performance.loading ? (
          <Loading />
        ) : q.error || performance.error ? (
          <ErrorState
            error={q.error || performance.error}
            retry={() => {
              q.refresh();
              performance.refresh();
            }}
          />
        ) : (
          <div className="table-wrap">
            <table className="data-table staff-table">
              <thead>
                <tr>
                  <th>Team member</th>
                  <th>Role</th>
                  <th>Sales</th>
                  <th>Net sales</th>
                  <th>Cash handled</th>
                  <th>M-Pesa / card</th>
                  <th>Closing status</th>
                  <th>Access</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users
                  .filter((u) =>
                    `${u.name} ${u.email} ${u.role_id}`.toLowerCase().includes(search.toLowerCase()),
                  )
                  .map((u) => {
                    const p = performance.data?.staff.find((s: Row) => s.id === u.id);
                    return (
                      <tr key={u.id}>
                        <td>
                          <div className="inline">
                            <span className="avatar">{initials(u.name)}</span>
                            <span>
                              <strong>{u.name}</strong>
                              <small className="cell-sub">{u.email}</small>
                            </span>
                          </div>
                        </td>
                        <td>
                          <Badge>{roleName(u.role_id)}</Badge>
                        </td>
                        <td>{p?.transactions ?? 0}</td>
                        <td className="money">{money(p?.sales_cents ?? 0)}</td>
                        <td>{money(p?.cash_cents ?? 0)}</td>
                        <td>
                          {money(p?.mpesa_cents ?? 0)}
                          <small className="cell-sub">Card {money(p?.card_cents ?? 0)}</small>
                        </td>
                        <td>
                          <Badge tone={p?.reconciliation_status === 'approved' ? 'green' : 'neutral'}>
                            {p?.reconciliation_status ?? 'No closing yet'}
                          </Badge>
                        </td>
                        <td>
                          <Badge tone={u.active ? 'green' : 'neutral'} dot>
                            {u.active ? 'Active' : 'Inactive'}
                          </Badge>
                        </td>
                        <td>
                          {auth.can('staff.write') && (
                            <div className="row-actions">
                              <button className="text-button" onClick={() => setUser(u)}>
                                Manage <ArrowUpRight size={12} />
                              </button>
                              {u.id !== auth.user!.id && (
                                <button
                                  className="text-button"
                                  onClick={() => {
                                    setReset(u);
                                    setPassword('');
                                    setReason('');
                                  }}
                                >
                                  Reset password
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
        <div className="human-note">
          <Users size={15} />
          Operational figures require human review. They must never be used to automatically accuse staff of
          misconduct.
        </div>
      </Panel>
      <Panel
        className="margin-top"
        title="Operational performance detail"
        subtitle="A more complete view of each person’s recorded activity."
      >
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Staff</th>
                <th>Average sale</th>
                <th>Discounts issued</th>
                <th>Correction requests</th>
                <th>Expenses entered</th>
                <th>Stock entries</th>
              </tr>
            </thead>
            <tbody>
              {performance.data?.staff.map((p: Row) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>{money(p.average_cents)}</td>
                  <td>{money(p.discounts_cents)}</td>
                  <td>{p.correction_requests}</td>
                  <td>{money(p.expenses_cents)}</td>
                  <td>{p.stock_entries}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      {user !== undefined && (
        <StaffForm
          user={user ?? undefined}
          onClose={() => setUser(undefined)}
          onSaved={() => {
            setUser(undefined);
            q.refresh();
            performance.refresh();
          }}
        />
      )}
      {permissions && (
        <Modal
          title="Roles & permissions"
          description="These controls are enforced on every API request, not only hidden in the interface."
          onClose={() => setPermissions(false)}
          wide
        >
          <div className="permission-matrix table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Permission</th>
                  {Object.values(q.data?.roles ?? {}).map((r: any) => (
                    <th key={r}>{r}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.entries(q.data?.permissions ?? {}).map(([key, label]) => (
                  <tr key={key}>
                    <td>{String(label)}</td>
                    {Object.keys(q.data?.roles ?? {}).map((role) => (
                      <td key={role}>
                        {q.data?.role_permissions[role]?.includes(key) ? (
                          <Check size={14} className="positive" />
                        ) : (
                          '—'
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Notice>
            Financial deletion and editing of historical entries are not permissions for any role. Corrections
            always preserve the original.
          </Notice>
        </Modal>
      )}
      {reset && (
        <Modal
          title={`Reset password for ${reset.name}`}
          description="Active sessions will be revoked. The user must change this password at next sign-in."
          onClose={() => setReset(null)}
        >
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void a.run(async () => {
                await api(`/staff/${reset.id}/reset-password`, {
                  method: 'POST',
                  body: { password, reason },
                });
                setReset(null);
                q.refresh();
              }, 'Temporary password set. Share it securely with the user.');
            }}
          >
            <Field label="New temporary password" required>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={12}
                autoComplete="new-password"
              />
            </Field>
            <Field label="Reason" required>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} />
            </Field>
            {a.error && <p className="form-error">{a.error}</p>}
            <Button type="submit" busy={a.busy}>
              <KeyRound size={15} />
              Reset & revoke sessions
            </Button>
          </form>
        </Modal>
      )}
    </>
  );
}
