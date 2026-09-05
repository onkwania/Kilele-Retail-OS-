/** Cloudflare Pages adapter for the EXISTING Kilele API. It is not a second auth/database/ledger. */
export type PagesEnvironment = { KILELE_API_ORIGIN?: string };
export type PagesContext = { request: Request; env: PagesEnvironment };
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function unavailable(status: number, code: string, message: string, mutation = false): Response {
  return Response.json(
    {
      error:
        message +
        (mutation
          ? ' The outcome of a previous submission may be unknown. Resolve its saved key; do not repeat the payment or create a replacement.'
          : ''),
      code,
    },
    { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } },
  );
}

function upstreamOrigin(value: string, current: URL): URL | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== 'https:' ||
      url.origin !== value ||
      url.username ||
      url.password ||
      url.origin === current.origin ||
      host === 'localhost' ||
      host === '[::1]' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      /^(?:0\.|127\.|10\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

async function boundedBody(request: Request): Promise<Uint8Array | undefined> {
  if (!request.body) return undefined;
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RangeError('Request too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function onRequest({ request, env }: PagesContext): Promise<Response> {
  const source = new URL(request.url);
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  if (!/^\/api(?:\/|$)/.test(source.pathname)) return unavailable(404, 'NOT_FOUND', 'API route not found.');
  if (!env.KILELE_API_ORIGIN) {
    return unavailable(
      503,
      'BACKEND_NOT_CONFIGURED',
      'The website is deployed, but its Kilele business API has not been configured. Ask the administrator to connect the existing API.',
    );
  }
  const origin = upstreamOrigin(env.KILELE_API_ORIGIN, source);
  if (!origin)
    return unavailable(
      503,
      'BACKEND_CONFIGURATION_ERROR',
      'The business API origin must be a different, valid public HTTPS origin without a path or credentials.',
    );
  if (Number(request.headers.get('Content-Length') ?? 0) > MAX_BODY_BYTES) {
    return unavailable(413, 'REQUEST_TOO_LARGE', 'This request exceeds the supported upload size.');
  }
  let body: Uint8Array | undefined;
  try {
    if (!['GET', 'HEAD'].includes(request.method)) body = await boundedBody(request);
  } catch {
    return unavailable(
      413,
      'REQUEST_TOO_LARGE',
      'This request could not be read within the supported upload size.',
    );
  }
  const target = new URL(source.pathname + source.search, origin);
  const headers = new Headers(request.headers);
  for (const name of [
    'host',
    'connection',
    'content-length',
    'forwarded',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-real-ip',
  ])
    headers.delete(name);
  // Origin, session cookies, CSRF and Idempotency-Key pass through unchanged.
  // Do not inject Supabase keys or rewrite Origin to bypass the upstream security policy.
  headers.set('X-Forwarded-Host', source.host);
  headers.set('X-Forwarded-Proto', 'https');
  const clientIp = request.headers.get('CF-Connecting-IP');
  if (clientIp) headers.set('X-Forwarded-For', clientIp);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 20_000);
  try {
    // Exactly ONE upstream attempt: retries of financial writes belong to the durable client workflow.
    const result = await fetch(target, {
      method: request.method,
      headers,
      body: body?.buffer as ArrayBuffer | undefined,
      redirect: 'manual',
      signal: timeout.signal,
    });
    if (result.status >= 300 && result.status < 400) {
      await result.body?.cancel();
      return unavailable(
        502,
        'BACKEND_INVALID_RESPONSE',
        'The API redirected instead of returning a business response. Check the upstream origin.',
        mutation,
      );
    }
    if (/^text\/html(?:;|$)/i.test(result.headers.get('Content-Type') ?? '')) {
      await result.body?.cancel();
      return unavailable(
        502,
        'BACKEND_INVALID_RESPONSE',
        'The API returned a website page instead of an API response. Check the deployment routing.',
        mutation,
      );
    }
    const responseHeaders = new Headers(result.headers);
    responseHeaders.set('Cache-Control', 'no-store');
    responseHeaders.set('X-Content-Type-Options', 'nosniff');
    return new Response(result.body, {
      status: result.status,
      statusText: result.statusText,
      headers: responseHeaders,
    });
  } catch {
    return unavailable(
      timeout.signal.aborted ? 504 : 502,
      'BACKEND_UNAVAILABLE',
      'The business API did not provide a confirmed response.',
      mutation,
    );
  } finally {
    clearTimeout(timer);
  }
}
