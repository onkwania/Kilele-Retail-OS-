import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import {
  api,
  setApiActor,
  getPendingSale,
  getPendingSubmissions,
  resolveScan,
  clearPendingSubmission,
} from '../src/lib/api.js';
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('sessionStorage', {
    get length() {
      return values.size;
    },
    key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k),
    clear: () => values.clear(),
  });
  setApiActor(crypto.randomUUID());
});
afterEach(() => vi.unstubAllGlobals());
const body = {
  session_id: 'test-session',
  items: [{ product_id: 'test-product', quantity: 1, version: 1, price_type: 'retail' }],
  payments: [{ method: 'Cash', amount: '100' }],
  expected_total: '100',
};
describe('Client submission recovery', () => {
  it('retains the original key until a successful body is read and ignores a new modal’s replacement key', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('{', { status: 201 }))
      .mockResolvedValueOnce(
        Response.json({ ok: true, id: 'saved-sale', ref: 'SL-FIXTURE', total_cents: 10000, change_cents: 0 }),
      );
    vi.stubGlobal('fetch', fetcher);
    await expect(
      api('/sales', { method: 'POST', body, key: 'original-submission-key' }),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(getPendingSale()?.body).toEqual(body);
    await expect(api('/sales', { method: 'POST', body, key: 'different-modal-key' })).resolves.toMatchObject({
      id: 'saved-sale',
    });
    expect(fetcher.mock.calls[1][1].headers['Idempotency-Key']).toBe('original-submission-key');
    expect(getPendingSale()).toBeNull();
  });
  it('blocks a different sale while the outcome is unknown and keeps recovery scoped to the same user', async () => {
    const actor = 'actor-' + crypto.randomUUID();
    setApiActor(actor);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Network disconnected')));
    await expect(api('/sales', { method: 'POST', body })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    const original = getPendingSale()!;
    await expect(
      api('/sales', { method: 'POST', body: { ...body, expected_total: '200' } }),
    ).rejects.toMatchObject({ code: 'PENDING_CHECKOUT' });
    setApiActor('another-user');
    expect(getPendingSale()).toBeNull();
    setApiActor(actor);
    expect(getPendingSale()?.key).toBe(original.key);
    clearPendingSubmission(original.storageKey);
  });
  it('does not lose a previously uncertain outcome when a retry fails CSRF / permission checks', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Network lost'))
      .mockResolvedValueOnce(Response.json({ error: 'CSRF expired' }, { status: 403 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(api('/sales', { method: 'POST', body })).rejects.toThrow();
    const original = getPendingSale()!;
    await expect(api('/sales', { method: 'POST', body })).rejects.toMatchObject({ status: 403 });
    expect(getPendingSale()?.key).toBe(original.key);
    clearPendingSubmission(original.storageKey);
  });
  it('allows two distinct confirmed all-cash sales with identical line contents', async () => {
    const fetcher = vi.fn().mockImplementation(() =>
      Promise.resolve(
        Response.json({
          ok: true,
          id: crypto.randomUUID(),
          ref: 'SL-FIXTURE',
          total_cents: 10000,
          change_cents: 0,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetcher);
    await api('/sales', { method: 'POST', body });
    await api('/sales', { method: 'POST', body });
    expect(fetcher.mock.calls[0][1].headers['Idempotency-Key']).not.toBe(
      fetcher.mock.calls[1][1].headers['Idempotency-Key'],
    );
    expect(getPendingSale()).toBeNull();
  });
  it('never sends a checkout if durable browser recovery storage is unavailable', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => null,
      get length() {
        return 0;
      },
      setItem: () => {
        throw new Error('Blocked storage');
      },
    });
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(api('/sales', { method: 'POST', body })).rejects.toMatchObject({ code: 'STORAGE_REQUIRED' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('preserves the full non-POS intent and blocks another financial action after response loss', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('Network lost'));
    vi.stubGlobal('fetch', fetcher);
    const expense = {
      amount: '50',
      category: 'Transport',
      method: 'Cash',
      description: 'Synthetic pending expense',
      expense_date: '2026-09-05',
    };
    await expect(api('/expenses', { method: 'POST', body: expense })).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
    });
    expect(getPendingSubmissions()[0].body).toEqual(expense);
    await expect(
      api('/purchases', { method: 'POST', body: { invoice_ref: 'different' } }),
    ).rejects.toMatchObject({ code: 'PENDING_SUBMISSION' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    clearPendingSubmission(getPendingSubmissions()[0].storageKey);
  });
  it('keeps a key when a successful HTTP response contains the wrong JSON contract', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({})));
    await expect(api('/sales', { method: 'POST', body })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(getPendingSale()).toBeTruthy();
    clearPendingSubmission(getPendingSale()!.storageKey);
  });
  it('scopes new pending intents to business and branch and recognises legacy keys', async () => {
    setApiActor({ id: 'same-user', business_id: 'business', branch_id: 'one' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Interrupted')));
    await expect(api('/sales', { method: 'POST', body })).rejects.toThrow();
    setApiActor({ id: 'same-user', business_id: 'business', branch_id: 'two' });
    expect(getPendingSale()).toBeNull();
    setApiActor({ id: 'same-user', business_id: 'business', branch_id: 'one' });
    expect(getPendingSale()).toBeTruthy();
    clearPendingSubmission(getPendingSale()!.storageKey);
    const storageKey = 'kilele-submission:same-user:' + 'a'.repeat(64);
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        storageKey,
        key: 'legacy-submission-key',
        method: 'POST',
        path: '/expenses',
        created_at: '2026-09-05T10:00:00Z',
      }),
    );
    expect(getPendingSubmissions()[0].key).toBe('legacy-submission-key');
    clearPendingSubmission(storageKey);
  });
  it('resolves verified barcode aliases before SKU and refuses ambiguous case-folded SKUs', () => {
    const products = [
      { sku: 'WINE', barcode: null, barcodes: [] },
      { sku: 'wine', barcode: 'TEST-ALIAS', barcodes: ['TEST-ALIAS', 'OTHER-TEST-CODE'] },
    ];
    expect(resolveScan(products, 'OTHER-TEST-CODE')).toBe(products[1]);
    expect(resolveScan(products, 'WiNe')).toBeNull();
    expect(resolveScan(products, 'WINE')).toBe(products[0]);
    expect(resolveScan(products, 'unknown')).toBeNull();
  });
});

it('does not recursively request session refresh when the session endpoint itself returns 401', async () => {
  const listener = vi.fn();
  window.addEventListener('auth-expired', listener);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ error: 'Unauthorised upstream' }, { status: 401 })),
  );
  await expect(api('/auth/me')).rejects.toMatchObject({ status: 401 });
  expect(listener).not.toHaveBeenCalled();
  window.removeEventListener('auth-expired', listener);
});
