import DocumentLink from './DocumentLink';
import { useEffect, useState } from 'react';
import { ShieldCheck, ArrowRight, FileText } from 'lucide-react';
import { api, type Row, money, numeric, today } from '../lib/api';
import { useAuth, useQuery, useAction } from '../lib/state';
import { Modal, Field, Input, MoneyInput, Button, Notice, FileUpload, Loading, ErrorState } from './ui';
import { ExpenseFields } from './forms';
export const REQUEST_LABELS: Record<string, string> = {
  sale_void: 'Sale void / full reversal',
  sale_return: 'Customer return',
  sale_correction: 'Sale correction (reverse & re-enter)',
  expense_reversal: 'Expense reversal',
  expense_correction: 'Expense correction',
  stock_count: 'Stock count',
  stock_adjustment: 'Stock adjustment',
  stock_reversal: 'Stock movement reversal',
  wastage: 'Wastage / stock issue',
  damaged: 'Damaged stock',
  stock_receipt: 'Stock receiving',
  price_change: 'Product price change',
  supplier_change: 'Supplier change',
  purchase_reversal: 'Supplier purchase reversal',
  supplier_payment_reversal: 'Supplier payment reversal',
  daily_closing: 'Daily closing review',
  closing_correction: 'Closing count correction',
  other: 'Other · human review note',
};
function group(kind: string) {
  return kind.startsWith('sale_')
    ? 'sales'
    : kind.startsWith('expense_')
      ? 'expenses'
      : kind === 'stock_reversal'
        ? 'inventory'
        : kind === 'price_change'
          ? 'products'
          : kind === 'supplier_change'
            ? 'suppliers'
            : kind === 'purchase_reversal'
              ? 'purchases'
              : kind === 'closing_correction'
                ? 'sessions'
                : kind === 'supplier_payment_reversal'
                  ? 'supplier_payments'
                  : 'other';
}
export function OriginalRecord({ value }: { value: Row | null }) {
  if (!value) return <Notice>No previous record — this is a new master-data request.</Notice>;
  const record = value.sale ?? value;
  const omit = [
    'items',
    'payments',
    'reversals',
    'password_hash',
    'business_id',
    'branch_id',
    'user_id',
    'payload_json',
    'notes',
    'image',
    'source_url',
    'permissions',
  ];
  const entries = Object.entries(record)
    .filter(
      ([k, v]) =>
        !omit.includes(k) &&
        !k.endsWith('_id') &&
        !['id', 'version', 'updated_at'].includes(k) &&
        v !== null &&
        typeof v !== 'object' &&
        v !== '',
    )
    .slice(0, 18);
  return (
    <div>
      <div className="original-record-grid">
        {entries.map(([k, v]) => (
          <div key={k}>
            <small>{k.replaceAll('_cents', ' (KES)').replaceAll('_', ' ')}</small>
            <span>{k.endsWith('_cents') ? money(Number(v), true) : String(v)}</span>
          </div>
        ))}
      </div>
      {value.items?.length > 0 && (
        <div className="table-wrap margin-top">
          <table className="data-table">
            <thead>
              <tr>
                <th>Original product</th>
                <th>Qty</th>
                <th>Recorded total</th>
              </tr>
            </thead>
            <tbody>
              {value.items.map((i: Row, index: number) => (
                <tr key={i.id ?? index}>
                  <td>
                    {i.product_name ?? i.name}
                    <small className="cell-sub">
                      {i.size ?? ''} {i.sku ?? ''}
                    </small>
                  </td>
                  <td>{i.quantity}</td>
                  <td>{money(i.total_cents, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <details className="full-record">
        <summary>Inspect full preserved record</summary>
        <pre className="json-state">{JSON.stringify(value, null, 2)}</pre>
      </details>
    </div>
  );
}
export function CorrectionModal({
  initialKind = 'other',
  entityId = '',
  onClose,
  onSaved,
}: {
  initialKind?: string;
  entityId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const auth = useAuth(),
    a = useAction();
  const [kind, setKind] = useState(initialKind),
    [selected, setSelected] = useState(entityId),
    [reason, setReason] = useState(''),
    [explanation, setExplanation] = useState(''),
    [requested, setRequested] = useState(''),
    [evidence, setEvidence] = useState<string | null>(null),
    [returnQty, setReturnQty] = useState<Record<string, number>>({}),
    [actual, setActual] = useState('');
  const [replacement, setReplacement] = useState<Row>({
    category: '',
    amount: '',
    expense_date: today(),
    method: 'Cash',
    description: '',
    payee: '',
    reference: '',
    document_id: null,
  });
  const [price, setPrice] = useState<Row>({
    cost: '',
    selling: '',
    wholesale: '',
    promo: '',
    tax_mode: 'unset',
    tax_bps: 0,
    version: 1,
  });
  const [supplier, setSupplier] = useState<Row>({
    name: '',
    contact: '',
    phone: '',
    email: '',
    location: '',
    account_ref: '',
    payment_terms: '',
    notes: '',
    active: true,
  });
  const g = group(kind);
  const lists = useQuery(g === 'other' || g === 'supplier_payments' ? null : `/${g}`);
  const detail = useQuery(
    selected && ['sales', 'expenses', 'purchases', 'supplier_payments'].includes(g)
      ? `/${g === 'supplier_payments' ? 'supplier-payments' : g}/${selected}`
      : null,
  );
  const rows: Row[] = lists.data?.[g === 'inventory' ? 'movements' : g === 'sessions' ? 'closings' : g] ?? [];
  const item = rows.find((r) => r.id === selected);
  const original: Row | null = detail.data ?? item ?? null;
  useEffect(() => {
    if (item && g === 'products')
      setPrice({
        cost: numeric(item.cost_cents),
        selling: numeric(item.selling_cents),
        wholesale: numeric(item.wholesale_cents),
        promo: numeric(item.promo_cents),
        tax_mode: item.tax_mode,
        tax_bps: item.tax_bps,
        version: item.version,
      });
    if (item && g === 'suppliers')
      setSupplier({
        name: item.name,
        contact: item.contact,
        phone: item.phone,
        email: item.email,
        location: item.location,
        account_ref: item.account_ref,
        payment_terms: item.payment_terms,
        notes: item.notes,
        active: !!item.active,
      });
  }, [selected, item, g]);
  useEffect(() => {
    if (detail.data?.expense) {
      const e = detail.data.expense;
      setReplacement({
        category: e.category,
        amount: numeric(e.amount_cents),
        expense_date: e.expense_date,
        method: e.method,
        description: e.description,
        payee: e.payee,
        reference: e.reference,
        document_id: e.document_id,
      });
    }
  }, [detail.data]);
  const allowed = [
    ...(auth.can('sales.read') ? ['sale_void', 'sale_return', 'sale_correction'] : []),
    ...(auth.can('expenses.read') ? ['expense_reversal', 'expense_correction'] : []),
    ...(auth.can('inventory.request') ? ['stock_reversal', 'price_change'] : []),
    ...(auth.can('suppliers.read') ? ['supplier_change'] : []),
    ...(auth.can('inventory.receive') ? ['purchase_reversal'] : []),
    ...(auth.can('sessions.own') ? ['closing_correction'] : []),
    'other',
    ...(initialKind === 'supplier_payment_reversal' ? ['supplier_payment_reversal'] : []),
  ].filter((k) => !entityId || group(k) === group(initialKind));
  const submit = async () => {
    let payload: Row = {};
    if (kind === 'sale_return')
      payload = {
        items: Object.entries(returnQty)
          .filter(([, q]) => q > 0)
          .map(([sale_item_id, quantity]) => ({ sale_item_id, quantity })),
      };
    if (kind === 'expense_correction') payload = { replacement };
    if (kind === 'price_change')
      payload = {
        ...price,
        cost: price.cost || null,
        selling: price.selling || null,
        wholesale: price.wholesale || null,
        promo: price.promo || null,
      };
    if (kind === 'supplier_change') payload = supplier;
    if (kind === 'closing_correction') payload = { actual };
    await api('/approvals', {
      method: 'POST',
      body: {
        kind,
        entity_id: selected,
        reason,
        explanation,
        requested_change: requested,
        evidence_id: evidence,
        payload,
      },
    });
    onSaved();
  };
  return (
    <Modal
      title="Request a correction"
      description="The original stays untouched. A different administrator reviews and authorises the change."
      onClose={onClose}
      wide
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(submit, 'Request submitted for independent review.');
        }}
      >
        <Notice icon={<ShieldCheck size={18} />}>
          <strong>No deleting. No silent edits.</strong> Approved requests create linked reversal or
          adjustment entries, with your reason and the reviewer’s decision preserved.
        </Notice>
        <div className="grid-2">
          <Field label="Request type" required>
            <select
              value={kind}
              onChange={(e) => {
                if (group(e.target.value) !== g) setSelected('');
                setKind(e.target.value);
              }}
            >
              {allowed.map((k) => (
                <option key={k} value={k}>
                  {REQUEST_LABELS[k]}
                </option>
              ))}
            </select>
          </Field>
          {g !== 'other' && (
            <Field label="Original record" required={kind !== 'supplier_change'}>
              {entityId ? (
                <Input value={item?.ref ?? item?.name ?? entityId} readOnly />
              ) : g === 'supplier_payments' ? (
                <Input
                  value={selected}
                  required
                  onChange={(e) => setSelected(e.target.value)}
                  placeholder="Original payment ID"
                />
              ) : (
                <select
                  value={selected}
                  required={kind !== 'supplier_change'}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  <option value="">
                    {kind === 'supplier_change' ? 'Request a new supplier' : 'Select the original record'}
                  </option>
                  {rows.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.ref ?? r.name ?? r.reference} {r.size ? '· ' + r.size : ''}{' '}
                      {r.product_name ? '· ' + r.product_name : ''}{' '}
                      {r.total_cents ? '· ' + money(r.total_cents) : ''}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}
        </div>
        {selected && detail.loading && ['sales', 'expenses', 'purchases'].includes(g) && <Loading />}
        {detail.error && <ErrorState error={detail.error} retry={detail.refresh} />}{' '}
        {original && (
          <details className="original-record-box" open>
            <summary>
              <ShieldCheck size={15} />
              Inspect original record
            </summary>
            <OriginalRecord value={original.expense ?? original.purchase ?? original.payment ?? original} />
          </details>
        )}
        {kind === 'sale_return' && detail.data && (
          <div>
            <h3 className="form-subtitle">Units physically returned to sellable stock</h3>
            <div className="return-items">
              {detail.data.items.map((i: Row) => (
                <div key={i.id}>
                  <span>
                    <strong>{i.product_name}</strong>
                    <small>{i.quantity - i.returned_qty} units eligible for return</small>
                  </span>
                  <Input
                    aria-label={`${i.product_name} return quantity`}
                    type="number"
                    min={0}
                    max={i.quantity - i.returned_qty}
                    value={returnQty[i.id] ?? 0}
                    onChange={(e) => setReturnQty((old) => ({ ...old, [i.id]: Number(e.target.value) }))}
                  />
                </div>
              ))}
            </div>
            <Notice>
              Refunds use the original charged prices and recorded cost. For damaged returns, record a
              separate approved damaged-stock adjustment after the return.
            </Notice>
          </div>
        )}
        {kind === 'sale_correction' && (
          <Notice tone="amber">
            Approval fully reverses the remaining sale. Then re-enter a correct sale through POS, referencing
            this request in your operational notes. The original is never rewritten.
          </Notice>
        )}
        {kind === 'expense_correction' && (
          <div>
            <h3 className="form-subtitle">Correct replacement expense</h3>
            <ExpenseFields
              form={replacement}
              set={(key, value) => setReplacement((old) => ({ ...old, [key]: value }))}
              upload={false}
            />
          </div>
        )}
        {kind === 'price_change' && (
          <div className="grid-2">
            {[
              ['cost', 'Buying price'],
              ['selling', 'Selling price'],
              ['wholesale', 'Wholesale price'],
              ['promo', 'Promotional price'],
            ].map(([key, label]) => (
              <Field key={key} label={label}>
                <MoneyInput
                  value={price[key]}
                  onChange={(value) => setPrice((old) => ({ ...old, [key]: value }))}
                  label={label}
                  placeholder="Price not set"
                />
              </Field>
            ))}
            <Field label="Tax treatment">
              <select
                value={price.tax_mode}
                onChange={(e) =>
                  setPrice((old) => ({
                    ...old,
                    tax_mode: e.target.value,
                    ...(['none', 'unset'].includes(e.target.value) ? { tax_bps: 0 } : {}),
                  }))
                }
              >
                <option value="unset">Not configured</option>
                <option value="none">No tax / exempt</option>
                <option value="inclusive">Tax inclusive</option>
                <option value="exclusive">Tax exclusive</option>
              </select>
            </Field>
            <Field label="Tax rate %">
              <Input
                type="number"
                min="0"
                max="100"
                step=".01"
                value={price.tax_bps / 100}
                disabled={['none', 'unset'].includes(price.tax_mode)}
                onChange={(e) =>
                  setPrice((old) => ({ ...old, tax_bps: Math.round(Number(e.target.value) * 100) }))
                }
              />
            </Field>
          </div>
        )}
        {kind === 'supplier_change' && (
          <div className="grid-2">
            {[
              ['name', 'Supplier name'],
              ['contact', 'Contact person'],
              ['phone', 'Phone'],
              ['email', 'Email'],
              ['location', 'Location'],
              ['account_ref', 'Account reference'],
              ['payment_terms', 'Payment terms'],
              ['notes', 'Notes'],
            ].map(([key, label]) => (
              <Field key={key} label={label} required={key === 'name'}>
                <Input
                  value={supplier[key]}
                  required={key === 'name'}
                  onChange={(e) => setSupplier((old) => ({ ...old, [key]: e.target.value }))}
                />
              </Field>
            ))}
          </div>
        )}
        {kind === 'closing_correction' && (
          <Field label="Correct actual cash count" required>
            <MoneyInput value={actual} onChange={setActual} label="Correct actual cash count" required />
          </Field>
        )}
        {kind === 'other' && (
          <Notice tone="amber">
            This type is a human review note only. It cannot change money or stock. Select the exact
            correction type above for a financial adjustment.
          </Notice>
        )}
        <Field label="Reason for request" required>
          <Input
            value={reason}
            required
            minLength={5}
            maxLength={2000}
            onChange={(e) => setReason(e.target.value)}
            placeholder="What needs to be corrected, and why?"
          />
        </Field>
        <div className="grid-2">
          <Field label="Explanation / what happened" required>
            <textarea
              required
              minLength={5}
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
              maxLength={2000}
            />
          </Field>
          <Field label="Requested correction / outcome" required>
            <textarea
              required
              minLength={5}
              value={requested}
              onChange={(e) => setRequested(e.target.value)}
              maxLength={2000}
              placeholder={REQUEST_LABELS[kind]}
            />
          </Field>
        </div>
        <FileUpload value={evidence} onUploaded={(id) => setEvidence(id)} />
        {evidence && (
          <DocumentLink className="text-button" id={evidence}>
            <FileText size={13} />
            View evidence
          </DocumentLink>
        )}
        {a.error && <p className="form-error">{a.error}</p>}
        <div className="form-footer">
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            busy={a.busy}
            disabled={
              !!detail.error || !reason.trim() || explanation.trim().length < 5 || requested.trim().length < 5
            }
          >
            Submit request <ArrowRight size={15} />
          </Button>
        </div>
      </form>
    </Modal>
  );
}
