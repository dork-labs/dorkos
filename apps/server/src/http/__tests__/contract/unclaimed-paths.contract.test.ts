/**
 * Contract for every request no route group claims: the paths outside `/api`
 * (the app's own pages and files, and anything else), and the `/api` paths
 * nothing serves. Until DOR-2818 the Express app answered all of them, behind
 * its own copy of the chain; after it, Hono does. That PR must pass this file
 * unchanged.
 *
 * What it pins, beside the files themselves (`spa.contract.test.ts`): which
 * steps of the chain still run for a path outside `/api` (CORS, `nosniff`,
 * body parsing, the session gate), which do not (the host guard), and how a
 * request nothing answers is refused, with and without a client build, and
 * with login on.
 *
 * Two answers it does not pin, on purpose: the `X-Powered-By: Express` header
 * and the `ETag` Express put on every JSON body. Nothing reads either.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  BOOT_HOOK_TIMEOUT_MS,
  bootComposedServer,
  checkContractCase,
  contractSuite,
  SERVER_ORIGIN,
  type ComposedServer,
  type ContractCase,
  stepUpAt,
} from './harness.js';

const SHELL = '<!doctype html><html><body><div id="root"></div></body></html>';
const BUNDLE = 'console.log("the app");';

const dist = mkdtempSync(path.join(tmpdir(), 'dorkos-contract-unclaimed-'));
mkdirSync(path.join(dist, 'assets'));
writeFileSync(path.join(dist, 'index.html'), SHELL);
writeFileSync(path.join(dist, 'assets', 'app-5e1d0b.js'), BUNDLE);
afterAll(() => rmSync(dist, { recursive: true, force: true }));

const PRODUCTION = { NODE_ENV: 'production', CLIENT_DIST_PATH: dist };

/** What every copy of the shell carries. */
const SHELL_HEADERS = {
  'content-type': /^text\/html\b/,
  'cache-control': 'no-store',
  'content-security-policy': /^default-src 'self'; .*frame-ancestors 'none'$/,
  'x-content-type-options': 'nosniff',
};

const API_NOT_FOUND = { error: 'Not found', code: 'API_NOT_FOUND' };
const HOST_NOT_ALLOWED = {
  error:
    'This instance does not answer to the address "evil.example". If that is how you reach DorkOS, list it in DORKOS_TRUSTED_HOSTS, or turn on login.',
  code: 'HOST_NOT_ALLOWED',
};

/** The page a request nothing answers gets, outside `/api`. */
function cannot(method: string, target: string): string {
  return (
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n' +
    `</head>\n<body>\n<pre>Cannot ${method} ${target}</pre>\n</body>\n</html>\n`
  );
}

/** The headers that page carries. */
const CANNOT_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'none'",
  'x-content-type-options': 'nosniff',
};

contractSuite(
  'unclaimed paths, with a client build',
  [
    {
      name: 'the shell carries the CORS headers for its own origin',
      path: '/',
      headers: { origin: SERVER_ORIGIN },
      expect: {
        status: 200,
        headers: {
          ...SHELL_HEADERS,
          'access-control-allow-origin': SERVER_ORIGIN,
          'access-control-allow-credentials': 'true',
          vary: /\bOrigin\b/,
        },
        body: SHELL,
      },
    },
    {
      name: 'a deep link with no Origin carries no CORS headers',
      path: '/team',
      expect: {
        status: 200,
        headers: { ...SHELL_HEADERS, 'access-control-allow-origin': null },
        body: SHELL,
      },
    },
    {
      name: 'a foreign Origin is refused on a page as on the API',
      path: '/team',
      headers: { origin: 'https://evil.example' },
      expect: {
        status: 403,
        headers: { 'access-control-allow-origin': null, 'content-type': /^application\/json\b/ },
        body: {
          error:
            'This instance does not answer to pages from "https://evil.example". If that is how you reach DorkOS, list it in DORKOS_CORS_ORIGIN, or open DorkOS at its own address.',
          code: 'ORIGIN_NOT_ALLOWED',
        },
      },
    },
    {
      name: 'a preflight for a page from its own origin is answered',
      method: 'OPTIONS',
      path: '/team',
      headers: { origin: SERVER_ORIGIN, 'access-control-request-method': 'POST' },
      expect: {
        status: 204,
        headers: {
          'access-control-allow-origin': SERVER_ORIGIN,
          'access-control-allow-credentials': 'true',
          'access-control-allow-methods': 'GET,HEAD,PUT,PATCH,POST,DELETE',
        },
        body: '',
      },
    },
    {
      name: 'the host guard leaves pages alone: a foreign Host still gets the shell',
      path: '/team',
      headers: { host: 'evil.example' },
      expect: { status: 200, headers: SHELL_HEADERS, body: SHELL },
    },
    {
      name: 'a foreign Host on an unknown /api path is refused before the 404',
      path: '/api/no-such-route',
      headers: { host: 'evil.example' },
      expect: { status: 403, body: HOST_NOT_ALLOWED },
    },
    {
      name: 'an /api path in capitals is still the API 404',
      path: '/API/no-such-route',
      expect: {
        status: 404,
        headers: { 'x-content-type-options': 'nosniff' },
        body: API_NOT_FOUND,
      },
    },
    {
      name: 'an unknown /api path with a trailing slash is the API 404',
      path: '/api/no-such-route/',
      expect: { status: 404, body: API_NOT_FOUND },
    },
    {
      name: 'a DELETE on an unknown /api path is the API 404',
      method: 'DELETE',
      path: '/api/no-such-route',
      expect: { status: 404, body: API_NOT_FOUND },
    },
    {
      name: 'a POST to a page is refused, never the shell',
      method: 'POST',
      path: '/team',
      body: { any: 'thing' },
      expect: { status: 404, headers: CANNOT_HEADERS, body: cannot('POST', '/team') },
    },
    {
      name: 'a refusal names the path it was asked for, encoded, without the query',
      method: 'PUT',
      path: '/x/some-extension/a<b>"c?q=<1>',
      expect: { status: 404, body: cannot('PUT', '/x/some-extension/a%3Cb%3E%22c') },
    },
    {
      name: 'a POST to a page with broken JSON fails the body parse first',
      method: 'POST',
      path: '/team',
      headers: { 'content-type': 'application/json' },
      body: '{"not json',
      expect: { status: 500, body: { error: 'Internal Server Error', code: 'INTERNAL_ERROR' } },
    },
    {
      name: 'a page takes no more than the 1 MB JSON limit either',
      method: 'POST',
      path: '/team',
      body: { blob: 'x'.repeat(1_100_000) },
      expect: {
        status: 413,
        body: { error: 'That is too large to send in one request.', code: 'REQUEST_TOO_LARGE' },
      },
    },
    {
      name: 'a missing bundle in capitals is the bundle 404',
      path: '/Assets/app-gone.js',
      expect: { status: 404, body: 'Not found: /Assets/app-gone.js' },
    },
    {
      name: 'HEAD on a missing bundle is the bundle 404 with no body',
      method: 'HEAD',
      path: '/assets/app-gone.js',
      expect: {
        status: 404,
        headers: { 'content-type': /^text\/plain\b/, 'x-content-type-options': 'nosniff' },
        body: '',
      },
    },
    {
      name: 'a bundle carries nosniff',
      path: '/assets/app-5e1d0b.js',
      expect: { status: 200, headers: { 'x-content-type-options': 'nosniff' }, body: BUNDLE },
    },
    {
      name: 'a PUT to a bundle is refused, never the file',
      method: 'PUT',
      path: '/assets/app-5e1d0b.js',
      expect: { status: 404, body: cannot('PUT', '/assets/app-5e1d0b.js') },
    },
    {
      name: 'an unknown /.well-known path is a deep link',
      path: '/.well-known/no-such-document',
      expect: { status: 200, headers: SHELL_HEADERS, body: SHELL },
    },
    {
      name: 'an unknown /a2a path is a deep link',
      path: '/a2a/no-such-path',
      expect: { status: 200, headers: SHELL_HEADERS, body: SHELL },
    },
  ],
  { env: PRODUCTION }
);

contractSuite('unclaimed paths, with no client build', [
  {
    name: 'a page is refused, since there is no app to serve',
    path: '/team',
    expect: { status: 404, headers: CANNOT_HEADERS, body: cannot('GET', '/team') },
  },
  {
    name: 'the root is refused too',
    path: '/',
    expect: { status: 404, body: cannot('GET', '/') },
  },
  {
    name: 'HEAD is refused with no body',
    method: 'HEAD',
    path: '/team',
    expect: { status: 404, headers: CANNOT_HEADERS, body: '' },
  },
  {
    name: 'an unknown /api path is still the API 404',
    path: '/api/no-such-route',
    expect: { status: 404, body: API_NOT_FOUND },
  },
]);

describe('contract: unclaimed paths with login on', () => {
  let server: ComposedServer | undefined;
  const OWNER = {
    email: `owner-${randomUUID().slice(0, 8)}@dork.test`,
    password: 'a-long-password-1',
  };

  /** Send one setup request, failing loudly if it does not succeed. */
  async function setup(
    method: string,
    url: string,
    body: unknown,
    origin: boolean,
    person: Record<string, string> = {}
  ): Promise<void> {
    const res = await fetch(`${server!.baseUrl}${url}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(origin ? { origin: server!.baseUrl } : {}),
        ...person,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${url} answered ${res.status}: ${await res.text()}`);
  }

  beforeAll(async () => {
    server = await bootComposedServer(PRODUCTION);
    await setup('POST', '/api/auth/sign-up/email', { ...OWNER, name: 'Owner' }, true);
    // Asking for a password is the owner's own act, after their step-up (DOR-3330).
    const person = await stepUpAt(server.baseUrl, OWNER.password);
    await setup('PATCH', '/api/config', { auth: { enabled: true } }, false, person);
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
  }, 30_000);

  const AUTH_REQUIRED = {
    error: 'Unauthorized',
    code: 'AUTH_REQUIRED',
  };

  const cases: ContractCase[] = [
    {
      name: 'the shell needs no credential, so the sign-in page can render',
      path: '/',
      expect: { status: 200, headers: SHELL_HEADERS, body: SHELL },
    },
    {
      name: 'a deep link needs no credential',
      path: '/session?session=abc',
      expect: { status: 200, headers: SHELL_HEADERS, body: SHELL },
    },
    {
      name: 'a bundle needs no credential',
      path: '/assets/app-5e1d0b.js',
      expect: { status: 200, body: BUNDLE },
    },
    {
      name: 'a missing bundle is the bundle 404',
      path: '/assets/app-gone.js',
      expect: { status: 404, body: 'Not found: /assets/app-gone.js' },
    },
    {
      name: 'an unknown /api path asks for a credential before it says 404',
      path: '/api/no-such-route',
      expect: { status: 401, body: AUTH_REQUIRED },
    },
    {
      name: 'the host guard is off with login on: a foreign Host meets the gate',
      path: '/api/no-such-route',
      headers: { host: 'evil.example' },
      expect: { status: 401, body: AUTH_REQUIRED },
    },
    {
      name: 'a POST to a page is refused, not asked for a credential',
      method: 'POST',
      path: '/team',
      expect: { status: 404, body: cannot('POST', '/team') },
    },
  ];
  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, testCase) => {
    await checkContractCase(server!.baseUrl, testCase);
  });
});
