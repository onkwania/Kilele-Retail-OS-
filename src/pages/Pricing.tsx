import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  Download,
  Upload,
  Save,
  ShieldCheck,
  FileSpreadsheet,
  SlidersHorizontal,
  Check,
} from 'lucide-react';
import { api, type Product, numeric, money, localDownload, minor } from '../lib/api';
import { useQuery, useAction, useToast } from '../lib/state';
import {
  Button,
  Panel,
  PageHeader,
  SearchBox,
  Pagination,
  Loading,
  ErrorState,
  Notice,
  Modal,
  Field,
  Input,
  Badge,
} from '../components/ui';
type PriceRow = {
  product_id: string;
  version: number;
  cost: string | null;
  selling: string | null;
  wholesale: string | null;
  promo: string | null;
  tax_mode: string;
  tax_bps: number;
};
const fromProduct = (p: Product): PriceRow => ({
  product_id: p.id,
  version: p.version,
  cost: p.cost_cents == null ? null : numeric(p.cost_cents),
  selling: p.selling_cents == null ? null : numeric(p.selling_cents),
  wholesale: p.wholesale_cents == null ? null : numeric(p.wholesale_cents),
  promo: p.promo_cents == null ? null : numeric(p.promo_cents),
  tax_mode: p.tax_mode,
  tax_bps: p.tax_bps,
});
function parseCsv(text: string) {
  const delimiter = text.split('\n')[0].includes('\t') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(cell.trim());
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  if (cell || row.length) {
    row.push(cell.trim());
    rows.push(row);
  }
  if (quoted) throw new Error('The file has an unclosed quoted field.');
  return rows;
}
const csvSafe = (s: string) =>
  `"${(/^[=+@-]/.test(s) && !/^[-+]?\d+(\.\d+)?$/.test(s) ? "'" : '') + s.replaceAll('"', '""')}"`;
export default function Pricing() {
  const navigate = useNavigate(),
    toast = useToast();
  const [params] = useSearchParams();
  const q = useQuery<{ products: Product[] }>('/products');
  const action = useAction();
  const [search, setSearch] = useState(''),
    [category, setCategory] = useState(''),
    [page, setPage] = useState(1),
    [changes, setChanges] = useState<Record<string, PriceRow>>({}),
    [reason, setReason] = useState(''),
    [confirm, setConfirm] = useState(false),
    [importOpen, setImportOpen] = useState(false),
    [csvText, setCsvText] = useState(''),
    [taxOpen, setTaxOpen] = useState(false),
    [taxMode, setTaxMode] = useState('inclusive'),
    [taxRate, setTaxRate] = useState(''),
    [discard, setDiscard] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const products = q.data?.products ?? [];
  const ids = params.get('ids')?.split(',');
  const filtered = products.filter(
    (p) =>
      (!ids || ids.includes(p.id)) &&
      (!category || p.category === category) &&
      `${p.name} ${p.sku} ${p.brand}`.toLowerCase().includes(search.toLowerCase()),
  );
  const changeCount = Object.keys(changes).length;
  useEffect(() => setPage(1), [search, category]);
  useEffect(() => {
    if (!changeCount) return;
    const handle = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handle);
    return () => window.removeEventListener('beforeunload', handle);
  }, [changeCount]);
  const update = (p: Product, key: keyof PriceRow, value: unknown) =>
    setChanges((old) => ({ ...old, [p.id]: { ...(old[p.id] ?? fromProduct(p)), [key]: value } }));
  const template = () =>
    localDownload(
      '\ufeff' +
        [
          [
            'SKU',
            'BuyingPrice',
            'SellingPrice',
            'WholesalePrice',
            'PromotionalPrice',
            'TaxMode',
            'TaxPercent',
          ],
          ...filtered.map((p) => [
            p.sku,
            numeric(p.cost_cents),
            numeric(p.selling_cents),
            numeric(p.wholesale_cents),
            numeric(p.promo_cents),
            p.tax_mode,
            String(p.tax_bps / 100),
          ]),
        ]
          .map((r) => r.map(csvSafe).join(','))
          .join('\r\n'),
      'kilele-price-sheet.csv',
    );
  const loadCsv = () => {
    try {
      const rows = parseCsv(csvText.replace(/^\ufeff/, ''));
      const header = rows.shift()?.map((h) => h.toLowerCase());
      const expected = [
        'sku',
        'buyingprice',
        'sellingprice',
        'wholesaleprice',
        'promotionalprice',
        'taxmode',
        'taxpercent',
      ];
      if (!header || expected.some((h, i) => h !== header[i]))
        throw new Error('Use the seven column headings from the downloadable template, in the same order.');
      if (rows.length > 500) throw new Error('Load at most 500 products at a time.');
      const imported: Record<string, PriceRow> = {};
      for (const [index, r] of rows.entries()) {
        if (r.length !== 7) throw new Error(`Row ${index + 2}: expected seven columns.`);
        const p = products.find((p) => p.sku === r[0]);
        if (!p) throw new Error(`Unknown SKU on row ${index + 2}: ${r[0]}`);
        if (imported[p.id]) throw new Error(`Duplicate SKU: ${p.sku}`);
        for (let i = 1; i <= 4; i++)
          if (r[i] && minor(r[i]) === null)
            throw new Error(`Invalid price for ${p.sku}. Use numbers without currency symbols.`);
        if (!['unset', 'none', 'inclusive', 'exclusive'].includes(r[5]))
          throw new Error(`Invalid tax mode for ${p.sku}.`);
        const bps = Number(r[6] || 0) * 100;
        if (!Number.isInteger(bps) || bps < 0 || bps > 10000)
          throw new Error(`Invalid tax percentage for ${p.sku}.`);
        imported[p.id] = {
          ...fromProduct(p),
          cost: r[1] || null,
          selling: r[2] || null,
          wholesale: r[3] || null,
          promo: r[4] || null,
          tax_mode: r[5],
          tax_bps: bps,
        };
      }
      setChanges((old) => ({ ...old, ...imported }));
      setImportOpen(false);
      toast(`${rows.length} rows loaded for review. Nothing has been saved yet.`, 'info');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <>
      <button
        className="text-button back-link"
        onClick={() => {
          if (changeCount) setDiscard(true);
          else navigate('/products');
        }}
      >
        <ArrowLeft size={14} />
        Back to catalogue
      </button>
      <PageHeader
        eyebrow="YOUR PRICES. YOUR CONTROL."
        title="The price sheet"
        description="Enter your prices in KES. Tab between cells, or load your own spreadsheet."
        actions={
          <>
            <Button variant="secondary" onClick={template}>
              <Download size={15} />
              Download template
            </Button>
            <Button variant="secondary" onClick={() => setImportOpen(true)}>
              <Upload size={15} />
              Load CSV
            </Button>
          </>
        }
      />
      <Notice>
        <strong>No prices are assumed.</strong> Blank prices mean “Price not set”. Confirm tax treatment for
        each product. Historical sales and stock costs are never recalculated when these values change.
      </Notice>
      <Panel className="margin-top">
        <div className="toolbar">
          <div className="toolbar-left">
            <SearchBox value={search} onChange={setSearch} placeholder="Find a product or SKU…" />
          </div>
          <div className="toolbar-right">
            <select
              className="select-filter"
              aria-label="Category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">All categories</option>
              {[...new Set(products.map((p) => p.category))].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <Button variant="secondary" size="sm" onClick={() => setTaxOpen(true)}>
              <SlidersHorizontal size={13} />
              Bulk tax settings
            </Button>
          </div>
        </div>
        {ids && (
          <div className="selection-bar">
            <span>
              Showing {filtered.length} selected product{filtered.length !== 1 ? 's' : ''}
            </span>
            <button className="text-button" onClick={() => navigate('/pricing')}>
              Show all products
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
              <table className="price-sheet">
                <thead>
                  <tr>
                    <th>Product / SKU</th>
                    <th>Buying price</th>
                    <th>Selling price</th>
                    <th>Wholesale</th>
                    <th>Promotional</th>
                    <th>Tax treatment</th>
                    <th>Tax %</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice((page - 1) * 20, page * 20).map((p) => {
                    const row = changes[p.id] ?? fromProduct(p);
                    return (
                      <tr key={p.id} className={changes[p.id] ? 'changed' : ''}>
                        <td>
                          <strong>{p.name}</strong>
                          <small>
                            {p.size} · {p.sku} {changes[p.id] ? ' · Unsaved' : ''}
                          </small>
                        </td>
                        {(['cost', 'selling', 'wholesale', 'promo'] as const).map((k) => (
                          <td key={k}>
                            <input
                              aria-label={`${p.sku} ${k}`}
                              inputMode="decimal"
                              value={row[k] ?? ''}
                              placeholder="Price not set"
                              onFocus={(e) => e.target.select()}
                              onChange={(e) => update(p, k, e.target.value || null)}
                            />
                          </td>
                        ))}
                        <td>
                          <select
                            aria-label={`${p.sku} tax treatment`}
                            value={row.tax_mode}
                            onChange={(e) => {
                              update(p, 'tax_mode', e.target.value);
                              if (['none', 'unset'].includes(e.target.value)) update(p, 'tax_bps', 0);
                            }}
                          >
                            <option value="unset">Not configured</option>
                            <option value="none">No tax / exempt</option>
                            <option value="inclusive">Tax inclusive</option>
                            <option value="exclusive">Tax exclusive</option>
                          </select>
                        </td>
                        <td>
                          <input
                            aria-label={`${p.sku} tax percent`}
                            type="number"
                            min="0"
                            max="100"
                            step="0.01"
                            disabled={['none', 'unset'].includes(row.tax_mode)}
                            value={row.tax_bps / 100}
                            onChange={(e) => update(p, 'tax_bps', Math.round(Number(e.target.value) * 100))}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination page={page} setPage={setPage} total={filtered.length} pageSize={20} />
          </>
        )}
      </Panel>
      <div className="price-sticky-bar">
        <ShieldCheck size={22} />
        <div>
          <strong>
            {changeCount
              ? `${changeCount} product${changeCount !== 1 ? 's' : ''} with unsaved changes`
              : 'All saved. Ready when you are.'}
          </strong>
          <small>Changes are only posted after you review and provide a reason.</small>
        </div>
        <Button variant="ghost" disabled={!changeCount} onClick={() => setDiscard(true)}>
          Discard changes
        </Button>
        <Button disabled={!changeCount} onClick={() => setConfirm(true)}>
          <Save size={15} />
          Review & save
        </Button>
      </div>
      {confirm && (
        <Modal
          title="Review price changes"
          description={`${changeCount} product${changeCount !== 1 ? 's' : ''} will be updated in one audited batch.`}
          onClose={() => !action.busy && setConfirm(false)}
          wide
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(async () => {
                await api('/products/prices', {
                  method: 'POST',
                  body: { rows: Object.values(changes), reason },
                });
                setChanges({});
                setReason('');
                setConfirm(false);
                q.refresh();
              }, 'Prices saved. Every change is recorded in the audit trail.');
            }}
          >
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Buying price</th>
                    <th>Selling price</th>
                    <th>Tax</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.values(changes).map((r) => {
                    const p = products.find((p) => p.id === r.product_id)!;
                    return (
                      <tr key={r.product_id}>
                        <td>
                          {p.name}
                          <small className="cell-sub">{p.size}</small>
                        </td>
                        <td>
                          {money(p.cost_cents)} → {r.cost === null ? 'Not set' : `KES ${r.cost}`}
                        </td>
                        <td>
                          {money(p.selling_cents)} → {r.selling === null ? 'Not set' : `KES ${r.selling}`}
                        </td>
                        <td>
                          {r.tax_mode} {r.tax_bps / 100}%
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Field className="margin-top" label="Reason for price changes" required>
              <Input
                value={reason}
                required
                minLength={5}
                maxLength={2000}
                placeholder="e.g. New supplier costs reviewed and retail prices updated"
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            {action.error && <p className="form-error margin-top">{action.error}</p>}
            <div className="form-footer">
              <Button variant="ghost" type="button" onClick={() => setConfirm(false)}>
                Back to editing
              </Button>
              <Button type="submit" busy={action.busy}>
                <Check size={16} />
                Save price changes
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {importOpen && (
        <Modal
          title="Load your price sheet"
          description="Import for review first. Nothing is posted until you save with a reason."
          onClose={() => setImportOpen(false)}
          wide
        >
          <div className="stack">
            <Notice tone="amber">
              Use the downloadable template. <strong>Blank price cells clear the current price.</strong> Every
              SKU must already exist in your catalogue. Do not include currency symbols.
            </Notice>
            <div className="inline">
              <Button variant="secondary" onClick={template}>
                <Download size={15} />
                Get current template
              </Button>
              <input
                ref={file}
                type="file"
                accept=".csv,.tsv,text/csv,text/tab-separated-values"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    if (f.size > 500000) {
                      toast('Choose a sheet smaller than 500 KB.', 'error');
                      return;
                    }
                    setCsvText(await f.text());
                  }
                }}
              />
              <Button variant="secondary" onClick={() => file.current?.click()}>
                <FileSpreadsheet size={15} />
                Choose file
              </Button>
            </div>
            <Field label="Or paste CSV / tab-separated spreadsheet cells">
              <textarea
                rows={10}
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                placeholder="SKU,BuyingPrice,SellingPrice,WholesalePrice,PromotionalPrice,TaxMode,TaxPercent"
                style={{ fontFamily: 'monospace' }}
              />
            </Field>
            <div className="form-footer">
              <Button variant="ghost" onClick={() => setImportOpen(false)}>
                Cancel
              </Button>
              <Button disabled={!csvText.trim()} onClick={loadCsv}>
                <Upload size={15} />
                Load for review
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {taxOpen && (
        <Modal
          title="Apply tax treatment"
          description={`This changes ${filtered.length} currently filtered products in the unsaved sheet.`}
          onClose={() => setTaxOpen(false)}
        >
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              const bps = taxMode === 'none' ? 0 : Math.round(Number(taxRate) * 100);
              if (!Number.isInteger(bps) || bps < 0 || bps > 10000) return;
              setChanges((old) => {
                const next = { ...old };
                for (const p of filtered)
                  next[p.id] = { ...(old[p.id] ?? fromProduct(p)), tax_mode: taxMode, tax_bps: bps };
                return next;
              });
              setTaxOpen(false);
              toast('Tax settings applied to the sheet. Review and save to post.', 'info');
            }}
          >
            <Notice>
              Choose the tax treatment that applies to your business. No VAT rate is assumed or pre-selected.
            </Notice>
            <Field label="Tax treatment">
              <select value={taxMode} onChange={(e) => setTaxMode(e.target.value)}>
                <option value="inclusive">Prices include tax</option>
                <option value="exclusive">Add tax to prices</option>
                <option value="none">No tax / exempt</option>
              </select>
            </Field>
            {taxMode !== 'none' && (
              <Field label="Tax rate (%)" required>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={taxRate}
                  onChange={(e) => setTaxRate(e.target.value)}
                  required
                  placeholder="Enter the applicable rate"
                />
              </Field>
            )}
            <Button type="submit">Apply to {filtered.length} products</Button>
          </form>
        </Modal>
      )}
      {discard && (
        <Modal
          title="Discard unsaved prices?"
          description="Your saved prices will stay exactly as they are."
          onClose={() => setDiscard(false)}
        >
          <div className="stack">
            <Badge tone="amber">{changeCount} unsaved product changes</Badge>
            <div className="form-footer">
              <Button variant="secondary" onClick={() => setDiscard(false)}>
                Keep editing
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setChanges({});
                  setDiscard(false);
                }}
              >
                Discard unsaved changes
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
