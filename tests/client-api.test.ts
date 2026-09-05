import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { api, setApiActor, getPendingSale, clearPendingSubmission } from '../src/lib/api.js';
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
      .mockResolvedValueOnce(Response.json({ id: 'saved-sale' }));
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
    const fetcher = vi
      .fn()
      .mockImplementation(() => Promise.resolve(Response.json({ id: crypto.randomUUID() })));
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
});
