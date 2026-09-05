/** Read-only public deployment smoke check. Never signs in or submits business records. */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export async function checkDeployment(address) {
  const origin = new URL(address);
  if (
    !['https:', 'http:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/'
  ) {
    throw new Error('Supply only the website origin, without credentials, a path, query or fragment.');
  }
  const checks = [];
  for (const path of ['/', '/api/health', '/api/auth/me']) {
    try {
      const response = await fetch(new URL(path, origin), {
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
      const mime = response.headers.get('Content-Type') ?? '';
      const body = await response.text();
      if (path === '/') {
        const scripts = [...body.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((m) => m[1]);
        checks.push({
          path,
          status: response.status,
          content_type: mime,
          ok:
            response.ok &&
            scripts.some((s) => /^\/assets\/.+\.js(?:[?#]|$)/.test(s)) &&
            !scripts.some((s) => /\/src\/|\.tsx?(?:[?#]|$)/.test(s)),
          entrypoints: scripts,
        });
      } else {
        let data = null;
        try {
          data = JSON.parse(body);
        } catch {
          /* An HTML fallback is not a healthy API. */
        }
        const valid =
          path === '/api/health'
            ? data?.status === 'ok'
            : data && Object.hasOwn(data, 'user') && typeof data.preview === 'boolean';
        checks.push({
          path,
          status: response.status,
          content_type: mime,
          ok: response.ok && /application\/json/i.test(mime) && !!valid,
          code: data?.code ?? null,
        });
      }
    } catch {
      checks.push({ path, ok: false, problem: 'Request failed or timed out' });
    }
  }
  return {
    origin: origin.origin,
    checked_at: new Date().toISOString(),
    ok: checks.every((c) => c.ok),
    checks,
    scope:
      'Public frontend and API availability only; no login, financial transaction or database/provider certification performed.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await checkDeployment(process.argv[2] ?? 'https://kilele-retail-os.pages.dev');
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
