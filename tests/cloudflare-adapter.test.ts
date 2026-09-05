import { afterEach, describe, expect, it, vi } from 'vitest';
import { onRequest } from '../functions/api/[[path]].js';
import { checkPagesBuild } from '../scripts/check-pages-build.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const site = 'https://kilele-retail-os.pages.dev';
const configured = { KILELE_API_ORIGIN: 'https://api.example.test' };
describe('Cloudflare Pages adapter — no invented backend or database connection', () => {
  it('returns a non-cacheable JSON 503 without making any upstream request when unconfigured', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const result = await onRequest({ request: new Request(site + '/api/auth/me'), env: {} });
    expect(result.status).toBe(503);
    expect(result.headers.get('Content-Type')).toContain('application/json');
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect((await result.json()).code).toBe('BACKEND_NOT_CONFIGURED');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    'http://api.example.test',
    'https://127.0.0.1',
    'https://localhost',
    'https://user:password@api.example.test',
    'https://api.example.test/private',
    'https://api.example.test/?secret=1',
    site,
  ])('refuses an unsafe or recursive upstream origin: %s', async (origin) => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const result = await onRequest({
      request: new Request(site + '/api/health'),
      env: { KILELE_API_ORIGIN: origin },
    });
    expect(result.status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('preserves exact body, cookie, CSRF, origin and idempotency key in one attempt; trusts no supplied forwarding header', async () => {
    const payload = '{"session_id":"synthetic","expected_total":"1.00"}';
    const fetcher = vi.fn(async () =>
      Response.json(
        { ok: true, id: 'synthetic-sale' },
        {
          status: 201,
          headers: { 'Set-Cookie': 'kilele_session=test-only; Path=/; HttpOnly; Secure; SameSite=Strict' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetcher);
    const result = await onRequest({
      request: new Request(site + '/api/sales?test=1', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'kilele_session=test-only',
          'X-CSRF-Token': 'test-csrf',
          'Idempotency-Key': 'test-submission-0001',
          Origin: site,
          'X-Forwarded-For': 'spoofed',
          'CF-Connecting-IP': '192.0.2.10',
        },
        body: payload,
      }),
      env: configured,
    });
    expect(result.status).toBe(201);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe('https://api.example.test/api/sales?test=1');
    const headers = new Headers(init.headers);
    expect(headers.get('Cookie')).toBe('kilele_session=test-only');
    expect(headers.get('X-CSRF-Token')).toBe('test-csrf');
    expect(headers.get('Idempotency-Key')).toBe('test-submission-0001');
    expect(headers.get('Origin')).toBe(site);
    expect(headers.get('X-Forwarded-For')).toBe('192.0.2.10');
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe(payload);
    expect(init.redirect).toBe('manual');
    expect(result.headers.get('Set-Cookie')).toContain('HttpOnly');
    expect(result.headers.get('Cache-Control')).toBe('no-store');
  });
  it('does not follow redirects or misrepresent HTML fallbacks as successful API responses', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example.test' } }),
      )
      .mockResolvedValueOnce(
        new Response('<html>not an API</html>', { headers: { 'Content-Type': 'text/html' } }),
      );
    vi.stubGlobal('fetch', fetcher);
    for (let i = 0; i < 2; i++) {
      const result = await onRequest({
        request: new Request(site + '/api/expenses', { method: 'POST', body: '{}' }),
        env: configured,
      });
      expect(result.status).toBe(502);
      const data = await result.json();
      expect(data.code).toBe('BACKEND_INVALID_RESPONSE');
      expect(data.error).toMatch(/outcome.*unknown/i);
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('keeps the outcome unknown after a failed upstream write, and never automatically retries', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('Synthetic transport failure'));
    vi.stubGlobal('fetch', fetcher);
    const result = await onRequest({
      request: new Request(site + '/api/sales', { method: 'POST', body: '{}' }),
      env: configured,
    });
    expect(result.status).toBe(502);
    expect((await result.json()).error).toContain('Resolve its saved key');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects oversized bodies before forwarding, including chunked requests without a size header', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const tooLong = new Request(site + '/api/documents', {
      method: 'POST',
      headers: { 'Content-Length': String(4 * 1024 * 1024 + 1) },
      body: '{}',
    });
    expect((await onRequest({ request: tooLong, env: configured })).status).toBe(413);
    const chunked = new Request(site + '/api/documents', {
      method: 'POST',
      body: 'x'.repeat(4 * 1024 * 1024 + 1),
    });
    expect((await onRequest({ request: chunked, env: configured })).status).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('streams legitimate receipt and report data, and retains upstream permission failures', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('%PDF-fixture', { headers: { 'Content-Type': 'application/pdf' } }))
      .mockResolvedValueOnce(
        Response.json({ error: 'Permission denied', code: 'FORBIDDEN' }, { status: 403 }),
      );
    vi.stubGlobal('fetch', fetcher);
    const pdf = await onRequest({ request: new Request(site + '/api/sales/test/receipt'), env: configured });
    expect(pdf.headers.get('Content-Type')).toBe('application/pdf');
    expect(await pdf.text()).toBe('%PDF-fixture');
    const denied = await onRequest({ request: new Request(site + '/api/reports/audit'), env: configured });
    expect(denied.status).toBe(403);
    expect((await denied.json()).code).toBe('FORBIDDEN');
  });
  it('rejects a source entry point and private files in the public build output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kilele-pages-output-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'index.html'), '<script type="module" src="/src/main.tsx"></script>');
    expect(() => checkPagesBuild(dir)).toThrow(/compiled/);
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<script type="module" src="/assets/app.js"></script>');
    writeFileSync(join(dir, 'assets/app.js'), 'export {};');
    expect(checkPagesBuild(dir).files).toBe(2);
    writeFileSync(join(dir, 'production.sqlite'), 'synthetic');
    expect(() => checkPagesBuild(dir)).toThrow(/private/);
  });
});
