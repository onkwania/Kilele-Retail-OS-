import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
} from 'react';
import {
  X,
  ChevronLeft,
  ChevronRight,
  Search,
  ArrowUpRight,
  LoaderCircle,
  Package,
  AlertCircle,
  ShieldCheck,
  Upload,
  FileText,
  Wine,
  Beer,
  CupSoda,
  Droplets,
  Zap,
  GlassWater,
  ShoppingBag,
} from 'lucide-react';
import { api, type Product, dateLabel, today, daysAgo } from '../lib/api';
import { useAction } from '../lib/state';
export function Button({
  children,
  variant = 'primary',
  size = '',
  busy,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: string;
  busy?: boolean;
}) {
  return (
    <button
      {...props}
      disabled={props.disabled || busy}
      className={`btn btn-${variant} ${size ? 'btn-' + size : ''} ${props.className ?? ''}`}
    >
      {busy ? <LoaderCircle size={16} className="spin" /> : null}
      {children}
    </button>
  );
}
export function IconButton({
  children,
  label,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button {...props} aria-label={label} title={label} className={`icon-button ${props.className ?? ''}`}>
      {children}
    </button>
  );
}
export function Badge({
  children,
  tone = 'neutral',
  dot = false,
}: {
  children: ReactNode;
  tone?: string;
  dot?: boolean;
}) {
  return (
    <span className={`badge badge-${tone}`}>
      {dot && <i />}
      {children}
    </span>
  );
}
export function Status({ status }: { status: string }) {
  const tone = ['approved', 'posted', 'active', 'completed', 'balanced'].includes(status)
    ? 'green'
    : ['pending', 'clarification', 'needs setup'].includes(status)
      ? 'amber'
      : ['rejected', 'reversed', 'shortage', 'inactive'].includes(status)
        ? 'red'
        : 'neutral';
  return (
    <Badge tone={tone} dot>
      {status.replaceAll('_', ' ')}
    </Badge>
  );
}
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="header-actions">{actions}</div>}
    </div>
  );
}
export function Panel({
  children,
  className = '',
  title,
  subtitle,
  action,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <section className={`panel ${className}`}>
      {title && (
        <header className="panel-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}
export function Empty({
  icon,
  title,
  description,
  action,
  compact = false,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty-state ${compact ? 'compact' : ''}`}>
      <div className="empty-icon">{icon ?? <Package size={23} />}</div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
export function Loading({ label = 'Loading your workspace…' }: { label?: string }) {
  return (
    <div className="loading-state">
      <LoaderCircle className="spin" size={22} />
      <span>{label}</span>
    </div>
  );
}
export function ErrorState({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <div className="error-state">
      <AlertCircle size={22} />
      <h3>Something needs your attention</h3>
      <p>{error}</p>
      {retry && (
        <Button variant="secondary" onClick={retry}>
          Try again
        </Button>
      )}
    </div>
  );
}
export function Notice({
  children,
  tone = 'info',
  icon,
}: {
  children: ReactNode;
  tone?: string;
  icon?: ReactNode;
}) {
  return (
    <div className={`notice notice-${tone}`}>
      {icon ?? <ShieldCheck size={18} />}
      <div>{children}</div>
    </div>
  );
}
export function Field({
  label,
  hint,
  children,
  required = false,
  className = '',
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  required?: boolean;
  className?: string;
}) {
  return (
    <label className={`field ${className}`}>
      <span>
        {label}
        {required && <em> *</em>}
      </span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`input ${props.className ?? ''}`} />;
}
export function MoneyInput({
  value,
  onChange,
  label = 'Amount',
  required = false,
  placeholder = '0.00',
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  required?: boolean;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <div className="money-input">
      <span>KES</span>
      <input
        aria-label={label}
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        placeholder={placeholder}
        disabled={disabled}
        pattern="[0-9]+([.][0-9]{1,2})?"
      />
    </div>
  );
}
export function SearchBox({
  value,
  onChange,
  placeholder = 'Search…',
  onEnter,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  onEnter?: () => void;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <div className="search-box">
      <Search size={17} />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onEnter?.();
          }
        }}
      />
      {value && (
        <button type="button" onClick={() => onChange('')} aria-label="Clear search">
          <X size={14} />
        </button>
      )}
    </div>
  );
}
export function Modal({
  title,
  description,
  children,
  onClose,
  wide = false,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  footer?: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const dialog = root.current;
    setTimeout(
      () => dialog?.querySelector<HTMLElement>('input:not([disabled]),select,textarea,button')?.focus(),
      30,
    );
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'Tab' && dialog) {
        const nodes = [
          ...dialog.querySelectorAll<HTMLElement>(
            'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]',
          ),
        ].filter((n) => n.offsetParent !== null);
        if (!nodes.length) return;
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.body.style.overflow = oldOverflow;
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={root}
        className={`modal ${wide ? 'modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="modal-header">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <IconButton label="Close dialog" onClick={onClose}>
            <X size={20} />
          </IconButton>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  );
}
export function Tabs({
  items,
  value,
  onChange,
}: {
  items: { id: string; label: string; count?: number }[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {items.map((item) => (
        <button
          role="tab"
          aria-selected={value === item.id}
          key={item.id}
          className={value === item.id ? 'active' : ''}
          onClick={() => onChange(item.id)}
        >
          {item.label}
          {item.count !== undefined && <span>{item.count}</span>}
        </button>
      ))}
    </div>
  );
}
export function Pagination({
  page,
  setPage,
  total,
  pageSize = 15,
}: {
  page: number;
  setPage: (p: number) => void;
  total: number;
  pageSize?: number;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pagination">
      <span>
        {total ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)}` : '0'} of{' '}
        {total.toLocaleString()} results
      </span>
      <div>
        <IconButton label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          <ChevronLeft size={16} />
        </IconButton>
        <span>
          Page {page} of {pages}
        </span>
        <IconButton label="Next page" disabled={page >= pages} onClick={() => setPage(page + 1)}>
          <ChevronRight size={16} />
        </IconButton>
      </div>
    </div>
  );
}
export function CategoryIcon({ category, size = 19 }: { category: string; size?: number }) {
  const Icon =
    category === 'Wines'
      ? Wine
      : category === 'Beer & Cider'
        ? Beer
        : category === 'Soft Drinks'
          ? CupSoda
          : category === 'Water'
            ? Droplets
            : category === 'Energy Drinks'
              ? Zap
              : category === 'Mixers'
                ? GlassWater
                : category === 'Snacks & Accessories'
                  ? ShoppingBag
                  : Wine;
  return <Icon size={size} strokeWidth={1.7} />;
}
export function ProductGlyph({
  product,
  large = false,
}: {
  product: Pick<Product, 'category' | 'name' | 'image' | 'category_color'> & Partial<Pick<Product, 'unit'>>;
  large?: boolean;
}) {
  const color = product.category_color || '#62816b';
  if (product.image)
    return (
      <div className={`product-glyph ${large ? 'large' : ''}`}>
        <img src={product.image} alt={product.name} />
      </div>
    );
  const canShape = product.unit === 'can';
  const packet = ['pack', 'case', 'bag', 'unit'].includes(product.unit ?? '');
  const water = product.category === 'Water';
  return (
    <div className={`product-glyph ${large ? 'large' : ''}`} style={{ background: color + '16', color }}>
      <svg viewBox="0 0 36 54" aria-hidden="true">
        {packet ? (
          <>
            <rect x="5" y="9" width="26" height="38" rx="3" fill={color} />
            <path d="M6 13h24M6 43h24" stroke="white" opacity=".5" />
            <rect x="8" y="22" width="20" height="14" rx="2" fill="#fbf8ed" />
            <path d="M13 28h10m-9 4h8" stroke={color} strokeWidth="1.4" />
          </>
        ) : canShape ? (
          <>
            <rect x="7" y="7" width="22" height="41" rx="5" fill={color} />
            <path d="M11 8h14M10 45h16" stroke="white" opacity=".65" strokeWidth="2" />
            <rect x="8" y="21" width="20" height="17" fill="#fbf8ed" opacity=".93" />
            <path d="M13 28h10m-9 4h8" stroke={color} strokeWidth="1.4" />
          </>
        ) : (
          <>
            <path
              d={
                water
                  ? 'M14 4h8v10l6 7v26a3 3 0 0 1-3 3H11a3 3 0 0 1-3-3V21l6-7z'
                  : 'M14 4h8v14c0 5 7 7 7 12v18a3 3 0 0 1-3 3H10a3 3 0 0 1-3-3V30c0-5 7-7 7-12z'
              }
              fill={color}
            />
            <rect x="13" y="3" width="10" height="7" rx="1.5" fill={color} />
            <rect x="9" y="29" width="18" height="14" rx="1" fill="#fbf8ed" opacity=".95" />
            <path d="M13 34h10m-9 4h8" stroke={color} strokeWidth="1.3" />
            <path d="M11 26v20" stroke="white" strokeWidth="1.5" opacity=".18" />
          </>
        )}
      </svg>
    </div>
  );
}
export function FileUpload({
  onUploaded,
  purpose = 'request',
  label = 'Attach supporting document',
  value,
}: {
  onUploaded: (id: string, url: string) => void;
  purpose?: string;
  label?: string;
  value?: string | null;
}) {
  const action = useAction();
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="upload-field">
      <input
        ref={input}
        type="file"
        accept="application/pdf,image/jpeg,image/png,image/webp"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          await action.run(async () => {
            if (file.size > 3_000_000) throw new Error('Please choose a file smaller than 3 MB.');
            const data = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result).split(',')[1]);
              reader.onerror = reject;
              reader.readAsDataURL(file);
            });
            const result = await api('/documents', {
              method: 'POST',
              body: { name: file.name, mime: file.type, data, purpose },
            });
            onUploaded(result.id, result.url);
          }, 'Document attached');
        }}
      />
      <button type="button" onClick={() => input.current?.click()} disabled={action.busy}>
        {action.busy ? (
          <LoaderCircle size={20} className="spin" />
        ) : value ? (
          <FileText size={20} />
        ) : (
          <Upload size={20} />
        )}
        <strong>{value ? 'Document attached' : label}</strong>
        <span>PDF, JPG, PNG or WebP · up to 3 MB</span>
      </button>
    </div>
  );
}
export function RangeControl({
  range,
  onChange,
}: {
  range: { from: string; to: string };
  onChange: (r: { from: string; to: string }) => void;
}) {
  const [open, setOpen] = useState(false),
    [draft, setDraft] = useState(range);
  const weekday = new Date(`${today()}T12:00:00Z`).getUTCDay();
  const presets = [
    { label: 'Today', from: today(), to: today() },
    { label: 'Yesterday', from: daysAgo(1), to: daysAgo(1) },
    { label: 'This week', from: daysAgo((weekday + 6) % 7), to: today() },
    { label: 'Last 7 days', from: daysAgo(6), to: today() },
    { label: 'This month', from: today().slice(0, 7) + '-01', to: today() },
    { label: 'Last 30 days', from: daysAgo(29), to: today() },
  ];
  const label =
    presets.find((p) => p.from === range.from && p.to === range.to)?.label ??
    `${dateLabel(range.from)} – ${dateLabel(range.to)}`;
  return (
    <div className="range-control">
      <Button
        variant="secondary"
        onClick={() => {
          setDraft(range);
          setOpen(!open);
        }}
      >
        <span className="calendar-mini">▦</span>
        {label}
        <ChevronRight size={14} style={{ transform: 'rotate(90deg)' }} />
      </Button>
      {open && (
        <>
          <div className="popover-dismiss" onClick={() => setOpen(false)} />
          <div className="range-popover">
            {presets.map((p) => (
              <button
                key={p.label}
                onClick={() => {
                  onChange({ from: p.from, to: p.to });
                  setOpen(false);
                }}
              >
                {p.label}
                <ArrowUpRight size={14} />
              </button>
            ))}
            <div className="range-inputs">
              <Field label="From">
                <Input
                  type="date"
                  max={draft.to}
                  value={draft.from}
                  onChange={(e) => setDraft((s) => ({ ...s, from: e.target.value }))}
                />
              </Field>
              <Field label="To">
                <Input
                  type="date"
                  min={draft.from}
                  max={today()}
                  value={draft.to}
                  onChange={(e) => setDraft((s) => ({ ...s, to: e.target.value }))}
                />
              </Field>
            </div>
            <Button
              size="sm"
              disabled={!draft.from || !draft.to || draft.from > draft.to || draft.to > today()}
              onClick={() => {
                onChange(draft);
                setOpen(false);
              }}
            >
              Apply dates
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
