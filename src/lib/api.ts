export type Row = Record<string, any>;
export type User = {
  id: string;
  name: string;
  email: string;
  role_id: string;
  business_id: string;
  branch_id: string;
  permissions: string[];
  must_change_password: number;
};
export type Product = {
  id: string;
  name: string;
  brand: string;
  category: string;
  category_color: string;
  subcategory: string;
  sku: string;
  barcode: string | null;
  size: string;
  unit: string;
  supplier_id: string | null;
  supplier: string | null;
  cost_cents: number | null;
  cost_configured?: number;
  selling_cents: number | null;
  wholesale_cents: number | null;
  promo_cents: number | null;
  stock: number;
  stock_value_cents: number;
  min_stock: number;
  reorder_level: number;
  active: number;
  tax_mode: string;
  tax_bps: number;
  image: string;
  notes: string;
  source_url: string;
  version: number;
  opening_stock: number;
};
let csrf = '';
let actorScope = 'anonymous';
export const setCsrf = (value: string) => {
  csrf = value;
};
export const setApiActor = (value: string | null) => {
  actorScope = value ?? 'anonymous';
};
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}
export type PendingSubmission = {
  storageKey: string;
  key: string;
  path: string;
  method: string;
  created_at: string;
  body?: Row;
};
const pendingMemory = new Map<string, PendingSubmission>();
const pendingPrefix = () => `kilele-submission:${actorScope}:`;
function readPending(key: string): PendingSubmission | null {
  try {
    const value = sessionStorage.getItem(key);
    if (value) return JSON.parse(value) as PendingSubmission;
  } catch {
    /* Memory fallback remains available when storage is restricted. */
  }
  return pendingMemory.get(key) ?? null;
}
export function getPendingSale(): PendingSubmission | null {
  const prefix = pendingPrefix();
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)!;
      if (key.startsWith(prefix)) {
        const p = readPending(key);
        if (p?.path === '/sales') return p;
      }
    }
  } catch {
    /* Fall back to the current tab. */
  }
  return (
    [...pendingMemory.values()].find((p) => p.storageKey.startsWith(prefix) && p.path === '/sales') ?? null
  );
}
export function clearPendingSubmission(key: string) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* Restricted storage. */
  }
  pendingMemory.delete(key);
  window.dispatchEvent(new Event('submission-state-changed'));
}
export async function api<T = Row>(
  path: string,
  options: { method?: string; body?: unknown; key?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  let submissionKey = options.key ?? crypto.randomUUID();
  let storageKey = '';
  let hadPending = false;
  if (method !== 'GET' && !path.startsWith('/auth') && !path.endsWith('/quote')) {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(method + path + (body ?? '{}')),
    );
    storageKey =
      pendingPrefix() +
      Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    const pending = path === '/sales' ? getPendingSale() : null;
    if (pending && pending.storageKey !== storageKey)
      throw new ApiError(
        'Resolve the saved checkout before starting a different sale.',
        409,
        'PENDING_CHECKOUT',
      );
    const previous = readPending(storageKey);
    hadPending = !!previous;
    submissionKey = previous?.key ?? options.key ?? submissionKey;
    const record: PendingSubmission = {
      storageKey,
      key: submissionKey,
      path,
      method,
      created_at: new Date().toISOString(),
      ...(path === '/sales' ? { body: options.body as Row } : {}),
    };
    pendingMemory.set(storageKey, record);
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(record));
    } catch {
      if (path === '/sales') {
        pendingMemory.delete(storageKey);
        throw new ApiError(
          'Checkout requires browser session storage for safe recovery. Enable storage and try again before accepting payment.',
          400,
          'STORAGE_REQUIRED',
        );
      }
    }
  }
  try {
    const response = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      signal: options.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(method !== 'GET' ? { 'X-CSRF-Token': csrf, 'Idempotency-Key': submissionKey } : {}),
      },
      body,
    });
    let data: Row;
    try {
      data = await response.json();
    } catch {
      throw new ApiError(
        'The server response could not be read. The submission key is preserved; verify the outcome before trying a different transaction.',
        response.status,
        'OUTCOME_UNKNOWN',
      );
    }
    if (response.status >= 500)
      throw new ApiError(
        data.error ?? 'The server could not confirm the outcome. Retry this same submission safely.',
        response.status,
        'OUTCOME_UNKNOWN',
      );
    if (storageKey && (response.ok || !hadPending || data.code === 'SUBMISSION_CANCELLED'))
      clearPendingSubmission(storageKey);
    if (!response.ok) {
      if (response.status === 401) window.dispatchEvent(new Event('auth-expired'));
      throw new ApiError(data.error ?? 'The request could not be completed.', response.status, data.code);
    }
    return data as T;
  } catch (error) {
    if (error instanceof ApiError || (error as Error).name === 'AbortError') throw error;
    throw new ApiError(
      !storageKey
        ? 'Unable to reach the server. Check your connection.'
        : 'Connection lost before final confirmation. Your submission key is preserved. Resolve the saved checkout or retry the exact same entry; do not create a replacement.',
      0,
      'OUTCOME_UNKNOWN',
    );
  } finally {
    if (storageKey) window.dispatchEvent(new Event('submission-state-changed'));
  }
}
/** Fetch under the current authenticated partition before opening a PDF / evidence viewer. */
export async function openDocument(path: string) {
  const popup = window.self !== window.top ? null : window.open('about:blank', '_blank');
  if (popup) {
    popup.opener = null;
    popup.document.title = 'Preparing document…';
  }
  try {
    const response = await fetch(`/api${path}`, { credentials: 'same-origin' });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error ?? 'Document could not be opened.');
    }
    const url = URL.createObjectURL(await response.blob());
    if (popup) {
      popup.location.replace(url);
      setTimeout(() => {
        try {
          if (!popup.closed && popup.location.href === 'about:blank') popup.close();
        } catch {
          /* The document viewer is isolated. */
        }
      }, 3000);
    } else {
      const link = document.createElement('a');
      link.href = url;
      const disposition = response.headers.get('Content-Disposition') ?? '';
      const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1],
        plain = disposition.match(/filename="?([^";]+)/i)?.[1];
      link.download = encoded ? decodeURIComponent(encoded) : (plain ?? 'kilele-document');
      link.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  } catch (e) {
    popup?.close();
    throw e;
  }
}
export async function download(path: string, filename: string) {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin' });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error ?? 'Download failed.');
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
export function localDownload(content: string, filename: string, mime = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const money = (cents: number | null | undefined, decimals = false) =>
  cents == null
    ? 'Not set'
    : new Intl.NumberFormat('en-KE', {
        style: 'currency',
        currency: 'KES',
        minimumFractionDigits: decimals ? 2 : 0,
        maximumFractionDigits: 2,
      })
        .format(cents / 100)
        .replace('Ksh', 'KES');
export const numeric = (cents: number | null | undefined) => (cents == null ? '' : (cents / 100).toFixed(2));
export function minor(value: string) {
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(value)) return null;
  const [whole, part = ''] = value.split('.');
  return Number(whole) * 100 + Number(part.padEnd(2, '0'));
}
export const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
export const dateLabel = (date: string | undefined, withTime = false) =>
  date
    ? new Date(date.length === 10 ? `${date}T12:00:00+03:00` : date).toLocaleString('en-GB', {
        timeZone: 'Africa/Nairobi',
        day: '2-digit',
        month: 'short',
        year: withTime ? undefined : 'numeric',
        ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
      })
    : '—';
export const daysAgo = (n: number) =>
  new Date(new Date(`${today()}T12:00:00Z`).getTime() - n * 86400000).toISOString().slice(0, 10);
export const initials = (name: string) =>
  name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
export const roleName = (role: string) =>
  ({
    super_admin: 'Super administrator',
    admin: 'Administrator',
    accountant: 'Staff accountant',
    cashier: 'Cashier',
    inventory: 'Inventory staff',
  })[role] ?? role;
export const titleCase = (s: string) => s.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
export const queryString = (data: Record<string, unknown>) =>
  new URLSearchParams(
    Object.entries(data)
      .filter(([, v]) => v !== '' && v != null)
      .map(([k, v]) => [k, String(v)]),
  ).toString();
export const isReady = (p: Product) =>
  p.active &&
  p.selling_cents !== null &&
  (p.cost_configured === 1 || p.cost_cents != null) &&
  p.tax_mode !== 'unset' &&
  p.stock > 0 &&
  p.size;
