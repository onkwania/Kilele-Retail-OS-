import { useState } from 'react';
import { Plus, X, ShieldCheck, ArrowRight } from 'lucide-react';
import { api, type Product, type Row, today, money, numeric, minor } from '../lib/api';
import { useAction, useAuth, useQuery } from '../lib/state';
import { Modal, Field, Input, MoneyInput, Button, Notice, FileUpload, IconButton, Loading } from './ui';
export function SessionForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const a = useAction();
  const [register, setRegister] = useState('Register 01'),
    [opening, setOpening] = useState('');
  return (
    <Modal
      title="Open your register"
      description="Count your opening cash before the first sale. This is your assigned session."
      onClose={onClose}
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(async () => {
            await api('/sessions', { method: 'POST', body: { register, opening } });
            onSaved();
          }, 'Your cash session is open.');
        }}
      >
        <Field label="Register name" required>
          <Input value={register} onChange={(e) => setRegister(e.target.value)} required />
        </Field>
        <Field
          label="Opening cash counted"
          required
          hint="Enter the physical cash in your drawer, not an assumed amount."
        >
          <MoneyInput
            value={opening}
            onChange={setOpening}
            label="Opening cash counted"
            required
            placeholder="Enter counted cash"
          />
        </Field>
        <Notice>
          <strong>One cashier, one register session.</strong> Closing locks this session permanently. Refunds
          and corrections use a new live session.
        </Notice>
        {a.error && <p className="form-error">{a.error}</p>}
        <div className="form-footer">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={a.busy}>
            Open register <ArrowRight size={15} />
          </Button>
        </div>
      </form>
    </Modal>
  );
}
export function SupplierForm({
  supplier,
  onClose,
  onSaved,
}: {
  supplier?: Row;
  onClose: () => void;
  onSaved: () => void;
}) {
  const a = useAction();
  const [form, setForm] = useState({
    name: supplier?.name ?? '',
    contact: supplier?.contact ?? '',
    phone: supplier?.phone ?? '',
    email: supplier?.email ?? '',
    location: supplier?.location ?? '',
    account_ref: supplier?.account_ref ?? '',
    payment_terms: supplier?.payment_terms ?? '',
    notes: supplier?.notes ?? '',
    active: supplier ? !!supplier.active : true,
    reason: '',
  });
  const set = (k: string, v: unknown) => setForm((s) => ({ ...s, [k]: v }));
  return (
    <Modal
      title={supplier ? 'Supplier details' : 'Add a supplier'}
      description="Keep a clear record of who supplies your business."
      onClose={onClose}
      wide
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(async () => {
            await api(supplier ? `/suppliers/${supplier.id}` : '/suppliers', {
              method: supplier ? 'PATCH' : 'POST',
              body: form,
            });
            onSaved();
          }, 'Supplier record saved.');
        }}
      >
        <div className="grid-2">
          {[
            ['name', 'Supplier name'],
            ['contact', 'Contact person'],
            ['phone', 'Phone number'],
            ['email', 'Email address'],
            ['location', 'Location / address'],
            ['account_ref', 'Account / reference'],
            ['payment_terms', 'Payment terms'],
          ].map(([k, l]) => (
            <Field key={k} label={l} required={k === 'name'}>
              <Input
                value={(form as Row)[k]}
                onChange={(e) => set(k, e.target.value)}
                type={k === 'email' ? 'email' : 'text'}
                required={k === 'name'}
                placeholder={k === 'payment_terms' ? 'e.g. Payment on delivery' : ''}
              />
            </Field>
          ))}
          <Field label="Status">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => set('active', e.target.checked)}
              />
              Active supplier
            </label>
          </Field>
          <Field label="Notes" className="span-2">
            <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} maxLength={2000} />
          </Field>
          <Field label="Reason for this change" className="span-2" required>
            <Input
              value={form.reason}
              minLength={5}
              required
              onChange={(e) => set('reason', e.target.value)}
            />
          </Field>
        </div>
        {a.error && <p className="form-error margin-top">{a.error}</p>}
        <div className="form-footer">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={a.busy}>
            Save supplier
          </Button>
        </div>
      </form>
    </Modal>
  );
}
export function StockForm({
  mode = 'stock_count',
  product,
  onClose,
  onSaved,
}: {
  mode?: string;
  product?: Product;
  onClose: () => void;
  onSaved: () => void;
}) {
  const a = useAction(),
    q = useQuery<{ products: Product[] }>('/products');
  const [productId, setProductId] = useState(product?.id ?? ''),
    [kind, setKind] = useState(mode),
    [quantity, setQuantity] = useState(''),
    [reason, setReason] = useState(''),
    [explanation, setExplanation] = useState(''),
    [evidence, setEvidence] = useState<string | null>(null);
  const p = q.data?.products.find((p) => p.id === productId);
  return (
    <Modal
      title={mode === 'opening' ? 'Enter opening stock' : 'Record a stock count or adjustment'}
      description={
        mode === 'opening'
          ? 'Opening balances are allowed once, before the first stock movement.'
          : 'Stock does not change until another authorised administrator approves.'
      }
      onClose={onClose}
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(
            async () => {
              await api(mode === 'opening' ? '/inventory/opening' : '/inventory/requests', {
                method: 'POST',
                body:
                  mode === 'opening'
                    ? { product_id: productId, quantity: Number(quantity), reason }
                    : {
                        product_id: productId,
                        kind,
                        quantity: Number(quantity),
                        reason,
                        explanation,
                        evidence_id: evidence,
                      },
              });
              onSaved();
            },
            mode === 'opening'
              ? 'Opening stock recorded in the ledger.'
              : 'Stock request submitted for independent approval.',
          );
        }}
      >
        <Field label="Product" required>
          <select required value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">Choose a product</option>
            {q.data?.products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.size} · {p.sku}
              </option>
            ))}
          </select>
        </Field>
        {p && (
          <div className="detail-grid">
            <div>
              <label>CURRENT STOCK</label>
              <strong>
                {p.stock} {p.unit}s
              </strong>
            </div>
            <div>
              <label>BUYING PRICE</label>
              <strong>{money(p.cost_cents)}</strong>
            </div>
            <div>
              <label>CURRENT VALUE</label>
              <strong>{money(p.stock_value_cents)}</strong>
            </div>
          </div>
        )}
        {mode !== 'opening' && (
          <Field label="Movement type">
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="stock_count">Physical stock count</option>
              <option value="stock_adjustment">Stock adjustment (+ / −)</option>
              <option value="wastage">Wastage / stock issue</option>
              <option value="damaged">Damaged stock</option>
            </select>
          </Field>
        )}
        <Field
          label={
            kind === 'stock_count'
              ? 'Actual units counted'
              : kind === 'stock_adjustment'
                ? 'Quantity to add (+) or remove (−)'
                : 'Quantity in units'
          }
          required
          hint={
            mode === 'opening'
              ? 'Valued at the product’s manually configured buying price.'
              : kind === 'stock_count'
                ? 'Enter the physical total, not the difference.'
                : 'Whole units of the catalogue package only.'
          }
        >
          <Input
            type="number"
            min={kind === 'stock_adjustment' ? -100000 : kind === 'stock_count' ? 0 : 1}
            max={100000}
            required
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </Field>
        {p && kind === 'stock_count' && quantity !== '' && (
          <Notice>
            System count: <strong>{p.stock}</strong> · Physical count: <strong>{quantity}</strong> · Requested
            change:{' '}
            <strong>
              {Number(quantity) - p.stock > 0 ? '+' : ''}
              {Number(quantity) - p.stock}
            </strong>{' '}
            units.
          </Notice>
        )}
        <Field label="Reason" required>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            minLength={5}
            placeholder="What happened, and why is this entry needed?"
          />
        </Field>
        {mode !== 'opening' && (
          <>
            <Field label="Supporting explanation">
              <textarea value={explanation} onChange={(e) => setExplanation(e.target.value)} />
            </Field>
            <FileUpload value={evidence} onUploaded={(id) => setEvidence(id)} />
          </>
        )}
        {a.error && <p className="form-error">{a.error}</p>}
        <div className="form-footer">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={a.busy}>
            {mode === 'opening' ? 'Post opening stock' : 'Submit for approval'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
export const EXPENSE_CATEGORIES = [
  'Rent',
  'Electricity',
  'Water',
  'Internet',
  'Transport',
  'Salaries',
  'Wages',
  'Security',
  'Cleaning',
  'Repairs',
  'Stock-related expenses',
  'Marketing',
  'Bank charges',
  'M-Pesa charges',
  'Licences',
  'Other',
];
export function ExpenseFields({
  form,
  set,
  upload = true,
}: {
  form: Row;
  set: (key: string, value: unknown) => void;
  upload?: boolean;
}) {
  return (
    <div className="grid-2">
      <Field label="Expense category" required>
        <select required value={form.category} onChange={(e) => set('category', e.target.value)}>
          <option value="">Choose a category</option>
          {EXPENSE_CATEGORIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </Field>
      <Field label="Amount" required>
        <MoneyInput value={form.amount} onChange={(v) => set('amount', v)} label="Expense amount" required />
      </Field>
      <Field label="Receipt / expense date" required>
        <Input
          type="date"
          max={today()}
          required
          value={form.expense_date}
          onChange={(e) => set('expense_date', e.target.value)}
        />
      </Field>
      <Field label="Payment method" required>
        <select value={form.method} onChange={(e) => set('method', e.target.value)}>
          {['Cash', 'M-Pesa', 'Card', 'Bank'].map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </Field>
      <Field label="Supplier / payee">
        <Input value={form.payee} onChange={(e) => set('payee', e.target.value)} />
      </Field>
      <Field label="Receipt / payment reference">
        <Input value={form.reference} onChange={(e) => set('reference', e.target.value)} />
      </Field>
      <Field label="Description" required className="span-2">
        <textarea
          minLength={3}
          required
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          placeholder="Describe the business expense."
        />
      </Field>
      {upload && (
        <div className="span-2">
          <FileUpload
            purpose="expense"
            value={form.document_id}
            onUploaded={(id) => set('document_id', id)}
          />
        </div>
      )}
    </div>
  );
}
export function ExpenseForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const a = useAction();
  const [form, setForm] = useState<Row>({
    category: '',
    amount: '',
    expense_date: today(),
    method: 'Cash',
    description: '',
    payee: '',
    reference: '',
    document_id: null,
  });
  const set = (key: string, value: unknown) => setForm((f) => ({ ...f, [key]: value }));
  return (
    <Modal
      title="Record an expense"
      description="A posted expense is permanent. Corrections always go through approval."
      onClose={onClose}
      wide
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(async () => {
            await api('/expenses', { method: 'POST', body: form });
            onSaved();
          }, 'Expense posted and recorded in the audit trail.');
        }}
      >
        <ExpenseFields form={form} set={set} />
        <div className="margin-top">
          <Notice>
            Cash expenses use your active register. The cash movement is posted now; the original receipt date
            is kept separately. Use Purchases for resale stock.
          </Notice>
        </div>
        {a.error && <p className="form-error margin-top">{a.error}</p>}
        <div className="form-footer">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={a.busy}>
            Post expense
          </Button>
        </div>
      </form>
    </Modal>
  );
}
export function PurchaseForm({
  onClose,
  onSaved,
  onNewSupplier,
}: {
  onClose: () => void;
  onSaved: () => void;
  onNewSupplier?: () => void;
}) {
  const auth = useAuth(),
    a = useAction();
  const supplierQ = useQuery('/suppliers'),
    productQ = useQuery<{ products: Product[] }>('/products');
  const [form, setForm] = useState({
    supplier_id: '',
    invoice_ref: '',
    purchase_date: today(),
    payment_method: 'Credit',
    notes: '',
    document_id: null as string | null,
    reason: '',
  });
  const [items, setItems] = useState([{ key: crypto.randomUUID(), product_id: '', quantity: 1, cost: '' }]);
  const set = (key: string, value: unknown) => setForm((f) => ({ ...f, [key]: value }));
  const total = items.reduce((s, i) => s + (minor(i.cost) ?? 0) * i.quantity, 0);
  const update = (key: string, field: string, value: unknown) =>
    setItems((old) => old.map((i) => (i.key === key ? { ...i, [field]: value } : i)));
  return (
    <Modal
      title="Receive supplier stock"
      description="Each received package creates a stock movement and a recorded inventory cost."
      onClose={onClose}
      wide
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(
            async () => {
              const result = await api('/purchases', {
                method: 'POST',
                body: { ...form, items: items.map(({ key: _key, ...i }) => i) },
              });
              onSaved();
              return result;
            },
            auth.can('inventory.post')
              ? 'Purchase posted. Inventory has been updated.'
              : 'Purchase submitted. Stock will update after approval.',
          );
        }}
      >
        {supplierQ.loading || productQ.loading ? (
          <Loading />
        ) : (
          <>
            <div className="grid-2">
              <Field label="Supplier" required>
                <select
                  value={form.supplier_id}
                  required
                  onChange={(e) => set('supplier_id', e.target.value)}
                >
                  <option value="">Select a supplier</option>
                  {supplierQ.data?.suppliers
                    .filter((s: Row) => s.active)
                    .map((s: Row) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
                {onNewSupplier && auth.can('suppliers.write') && (
                  <button className="text-button" type="button" onClick={onNewSupplier}>
                    <Plus size={13} />
                    Add a supplier first
                  </button>
                )}
              </Field>
              <Field label="Supplier invoice / delivery reference" required>
                <Input
                  required
                  value={form.invoice_ref}
                  minLength={2}
                  onChange={(e) => set('invoice_ref', e.target.value)}
                />
              </Field>
              <Field label="Invoice date" required>
                <Input
                  type="date"
                  required
                  value={form.purchase_date}
                  max={today()}
                  onChange={(e) => set('purchase_date', e.target.value)}
                />
              </Field>
              <Field label="Payment terms / method">
                <select value={form.payment_method} onChange={(e) => set('payment_method', e.target.value)}>
                  {['Credit', 'Cash', 'M-Pesa', 'Card', 'Bank'].map((m) => (
                    <option key={m} value={m}>
                      {m === 'Credit' ? 'On supplier credit (unpaid)' : m}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="purchase-lines">
              <div className="purchase-lines-heading">
                <span>PRODUCT</span>
                <span>QUANTITY</span>
                <span>UNIT COST · KES</span>
                <span>LINE TOTAL</span>
                <span />
              </div>
              {items.map((i) => (
                <div className="purchase-line" key={i.key}>
                  <select
                    aria-label="Purchase product"
                    required
                    value={i.product_id}
                    onChange={(e) => {
                      update(i.key, 'product_id', e.target.value);
                      const p = productQ.data?.products.find((p) => p.id === e.target.value);
                      update(i.key, 'cost', numeric(p?.cost_cents));
                    }}
                  >
                    <option value="">Choose a product</option>
                    {productQ.data?.products
                      .filter((p) => p.active)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} · {p.size} · {p.sku}
                        </option>
                      ))}
                  </select>
                  <Input
                    aria-label="Purchase quantity"
                    type="number"
                    min="1"
                    max="100000"
                    required
                    value={i.quantity || ''}
                    onChange={(e) => update(i.key, 'quantity', Number(e.target.value))}
                  />
                  <Input
                    aria-label="Purchase unit cost"
                    inputMode="decimal"
                    value={i.cost}
                    required
                    pattern="[0-9]+([.][0-9]{1,2})?"
                    placeholder="Not set"
                    onChange={(e) => update(i.key, 'cost', e.target.value)}
                  />
                  <strong>{money((minor(i.cost) ?? 0) * i.quantity)}</strong>
                  <IconButton
                    type="button"
                    label="Remove unposted purchase item"
                    disabled={items.length === 1}
                    onClick={() => setItems((old) => old.filter((row) => row.key !== i.key))}
                  >
                    <X size={15} />
                  </IconButton>
                </div>
              ))}
              <button
                type="button"
                className="text-button margin-top"
                onClick={() =>
                  setItems((old) => [
                    ...old,
                    { key: crypto.randomUUID(), product_id: '', quantity: 1, cost: '' },
                  ])
                }
              >
                <Plus size={15} />
                Add another product
              </button>
              <div className="purchase-total">
                <span>Total purchase cost</span>
                <strong>{money(total, true)}</strong>
              </div>
            </div>
            <div className="grid-2">
              <Field label="Receiving reason / confirmation" required>
                <Input
                  value={form.reason}
                  required
                  minLength={5}
                  onChange={(e) => set('reason', e.target.value)}
                  placeholder="Confirm delivery and quantities received"
                />
              </Field>
              <Field label="Notes">
                <Input value={form.notes} onChange={(e) => set('notes', e.target.value)} />
              </Field>
              <div className="span-2">
                <FileUpload
                  purpose="purchase"
                  value={form.document_id}
                  onUploaded={(id) => set('document_id', id)}
                />
              </div>
            </div>
            <div className="margin-top">
              <Notice icon={<ShieldCheck size={18} />}>
                <strong>
                  {auth.can('inventory.post')
                    ? 'You are authorised to post receiving.'
                    : 'Another administrator must approve this receipt.'}
                </strong>{' '}
                Inventory uses the actual unit costs entered above. An immediate cash payment uses the posting
                administrator’s open register; the invoice reference is used as the settlement reference.
                Select credit to record a separate payment reference later.
              </Notice>
            </div>
            {a.error && <p className="form-error margin-top">{a.error}</p>}
            <div className="form-footer">
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button busy={a.busy} type="submit">
                {auth.can('inventory.post')
                  ? 'Post purchase & receive stock'
                  : 'Submit purchase for approval'}
              </Button>
            </div>
          </>
        )}
      </form>
    </Modal>
  );
}
