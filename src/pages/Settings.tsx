import { useEffect, useState } from 'react';
import { Save, Building2, ShieldCheck, LockKeyhole, Globe, KeyRound, ArrowUpRight } from 'lucide-react';
import { api, type Row, numeric } from '../lib/api';
import { useQuery, useAuth, useAction } from '../lib/state';
import {
  Button,
  Badge,
  PageHeader,
  Panel,
  Field,
  Input,
  MoneyInput,
  Notice,
  Loading,
  ErrorState,
  Modal,
} from '../components/ui';
import { PasswordForm } from './Login';
export default function Settings() {
  const q = useQuery('/settings'),
    auth = useAuth(),
    a = useAction();
  const [form, setForm] = useState<Row | null>(null),
    [password, setPassword] = useState(false);
  useEffect(() => {
    if (q.data) {
      const b = q.data.business,
        branch = q.data.branch;
      setForm({
        name: b.name,
        address: b.address,
        phone: b.phone,
        tax_pin: b.tax_pin,
        receipt_footer: b.receipt_footer,
        variance_threshold: numeric(b.variance_threshold_cents),
        branch_name: branch.name,
        location: branch.location,
        reason: '',
      });
    }
  }, [q.data]);
  const set = (k: string, v: unknown) => setForm((old) => ({ ...old, [k]: v }));
  return (
    <>
      <PageHeader
        eyebrow="A WORKSPACE THAT FITS YOUR BUSINESS"
        title="Business settings"
        description="Keep your identity current and your controls clear."
        actions={
          <Button variant="secondary" onClick={() => setPassword(true)}>
            <KeyRound size={15} />
            Change password
          </Button>
        }
      />
      {auth.preview && (
        <Notice tone="amber">
          <strong>This is an isolated sandbox preview.</strong> Do not use it for real business records.
          Production requires a clean database, HTTPS, named user accounts, tested backups, and tax/payment
          integration review.
        </Notice>
      )}
      {q.loading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} retry={q.refresh} />
      ) : (
        form && (
          <div className="settings-layout margin-top">
            <Panel
              title="Business identity"
              subtitle="These details appear on your internal sales receipts."
              action={<Building2 size={19} className="muted" />}
            >
              <form
                className="settings-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void a.run(async () => {
                    await api('/settings', { method: 'PATCH', body: form });
                    await auth.refresh();
                    q.refresh();
                  }, 'Business settings saved and audited.');
                }}
              >
                <div className="grid-2">
                  <Field label="Business name" required>
                    <Input
                      value={form.name}
                      required
                      minLength={2}
                      onChange={(e) => set('name', e.target.value)}
                    />
                  </Field>
                  <Field label="Branch name" required>
                    <Input
                      value={form.branch_name}
                      required
                      minLength={2}
                      onChange={(e) => set('branch_name', e.target.value)}
                    />
                  </Field>
                  <Field label="Business address">
                    <Input value={form.address} onChange={(e) => set('address', e.target.value)} />
                  </Field>
                  <Field label="Branch location">
                    <Input value={form.location} onChange={(e) => set('location', e.target.value)} />
                  </Field>
                  <Field label="Business phone">
                    <Input
                      value={form.phone}
                      onChange={(e) => set('phone', e.target.value)}
                      placeholder="+254…"
                    />
                  </Field>
                  <Field label="KRA PIN (optional)">
                    <Input
                      value={form.tax_pin}
                      onChange={(e) => set('tax_pin', e.target.value)}
                      placeholder="Enter your actual business PIN"
                    />
                  </Field>
                  <Field label="Receipt footer" className="span-2">
                    <textarea
                      value={form.receipt_footer}
                      onChange={(e) => set('receipt_footer', e.target.value)}
                      maxLength={500}
                    />
                  </Field>
                  <Field
                    label="Significant cash variance threshold"
                    className="span-2"
                    hint="A reason is mandatory when the absolute variance exceeds this amount. Zero requires an explanation for any difference."
                  >
                    <MoneyInput
                      value={form.variance_threshold}
                      onChange={(v) => set('variance_threshold', v)}
                      label="Significant cash variance threshold"
                      required
                    />
                  </Field>
                  <Field label="Reason for settings change" required className="span-2">
                    <Input
                      value={form.reason}
                      onChange={(e) => set('reason', e.target.value)}
                      required
                      minLength={5}
                    />
                  </Field>
                </div>
                {a.error && <p className="form-error margin-top">{a.error}</p>}
                <div className="form-footer">
                  <Button type="submit" busy={a.busy}>
                    <Save size={15} />
                    Save business settings
                  </Button>
                </div>
              </form>
            </Panel>
            <div className="stack">
              <Panel
                title="Business controls"
                subtitle="Accounting safeguards are always on."
                action={<ShieldCheck size={19} className="muted" />}
              >
                <div className="settings-controls">
                  {[
                    'No financial record deletion',
                    'Independent approval required',
                    'Original transaction snapshots',
                    'Immutable, hash-linked audit trail',
                    'Server-enforced role permissions',
                    'Atomic stock and payment posting',
                  ].map((c) => (
                    <div key={c}>
                      <LockKeyhole size={14} />
                      <span>{c}</span>
                      <Badge tone="green">Protected</Badge>
                    </div>
                  ))}
                </div>
              </Panel>
              <Panel title="Regional & accounting profile" action={<Globe size={18} className="muted" />}>
                <div className="settings-profile">
                  {Object.entries(q.data?.controls ?? {}).map(([k, v]) => (
                    <div key={k}>
                      <small>{k.replaceAll('_', ' ')}</small>
                      <strong>{String(v)}</strong>
                    </div>
                  ))}
                </div>
              </Panel>
              <Notice>
                Tax is configured per product by authorised users. Supplier costs are entered as your
                inventory valuation cost. Review tax treatment with your accountant; these internal receipts
                are not KRA eTIMS fiscal invoices.
              </Notice>
              <a className="text-button" href="/api/health" target="_blank" rel="noreferrer">
                Check API availability <ArrowUpRight size={13} />
              </a>
            </div>
          </div>
        )
      )}
      {password && (
        <Modal
          title="Change your password"
          description="Use a unique passphrase of at least 12 characters."
          onClose={() => setPassword(false)}
        >
          <PasswordForm onDone={() => setPassword(false)} />
        </Modal>
      )}
    </>
  );
}
