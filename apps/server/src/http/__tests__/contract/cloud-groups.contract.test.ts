/**
 * Contract for the cloud and remote-access route groups, which move to Hono
 * together in DOR-2806: the DorkOS account (`/api/cloud`), its hosted spaces
 * (`/api/cloud/communities`), the person's own tunnel (`/api/tunnel`, with its
 * event stream) and DorkOS managed remote access (`/api/remote-access`). That
 * PR must pass this file unchanged.
 *
 * Nothing here leaves the machine. Every server is a `DORKOS_TEST_RUNTIME`
 * one, so the account link and every `/v1` call answer from the in-process
 * fake Cloud (`services/runtimes/test-mode/fake-cloud-*.ts`), and no ngrok
 * token is handed to any of them, so no tunnel ever opens.
 *
 * Four servers:
 *
 * 1. Login off, unlinked: every read's shape, the writes' refusals and
 *    not-linked answers, 404s, HEAD, trailing slashes, the refusals a caller
 *    earns with headers alone, and the hosted-space gate with spaces off.
 * 2. Login off, driven by hand: the tunnel's event stream; an account linked
 *    through the fake approval page, read, refused by the fake where it serves
 *    nothing, checked and unlinked; the hosted spaces with spaces on.
 * 3. Login off, reached at a trusted host name that is not this computer:
 *    remote access refuses every change.
 * 4. Login on: no credential is refused at the session gate; an API key is not
 *    a person, so it may not start a tunnel, link the account or change remote
 *    access; the owner's cookie may.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BOOT_HOOK_TIMEOUT_MS,
  bootComposedServer,
  checkContractCase,
  contractSuite,
  type ComposedServer,
  type ContractCase,
  signInAt,
} from './harness.js';

/** No ngrok token reaches any server here, whatever this shell exports. */
const NO_TUNNEL = { NGROK_AUTHTOKEN: '' };
/** An official space the hosted-space gate can name, never dialled. */
const OFFICIAL_SPACE = {
  DORKOS_OFFICIAL_SPACE_URL: 'https://space.contract.example/contract-space',
};
const BASE_ENV = { ...NO_TUNNEL, ...OFFICIAL_SPACE };

const JSON_TYPE = { 'content-type': /^application\/json\b/ };
const NO_STORE = { 'cache-control': 'no-store' };
const NOT_FOUND = { error: 'Not found', code: 'API_NOT_FOUND' };
/** An agent header this machine never minted: the caller is a machine, unverified. */
const AGENT = { 'X-DorkOS-Agent': 'not-a-real-token' };
const MALFORMED_JSON = z.object({ code: z.literal('INTERNAL_ERROR') }).loose();
const UNAVAILABLE = { available: false };
const NOT_LINKED = { ok: false, message: 'This instance is not linked to a DorkOS account.' };
const SPACE_NOT_LINKED = { ok: false, message: 'This DorkOS is not linked to a DorkOS account.' };
const SPACES_DISABLED = {
  error: 'Spaces are switched off. Turn them on in Settings → Advanced → Experiments.',
  code: 'SPACES_DISABLED',
};
const OPERATOR_ONLY = z
  .object({ code: z.literal('operator_only_config'), error: z.string() })
  .strict();
const EXPOSURE_NEEDS_LOGIN = z
  .object({ code: z.literal('AUTH_REQUIRED_FOR_EXPOSURE'), error: z.string() })
  .strict();
const PERSON_ONLY_ERROR = (error: string) => ({ error, code: 'person_only' });
const PERSON_ONLY_ENVELOPE = (message: string) => ({ ok: false, code: 'person_only', message });
const UNLINKED_SUMMARY = z.object({ linked: z.literal(false) }).loose();
const LINK_IDLE = z.object({ state: z.literal('idle') }).loose();
const CREDITS = z
  .object({
    enabled: z.boolean(),
    killed: z.boolean(),
    linked: z.boolean(),
    ready: z.boolean(),
    runtimes: z.object({}).loose(),
  })
  .loose();
const TUNNEL_STATUS = z.object({ connected: z.boolean(), url: z.unknown() }).loose();
const REPORT = z.object({ mode: z.string() }).loose();

contractSuite(
  'cloud and remote-access groups',
  [
    // cloud: the link
    {
      name: 'GET /api/cloud/status answers the unlinked summary',
      path: '/api/cloud/status',
      expect: { status: 200, headers: JSON_TYPE, schema: UNLINKED_SUMMARY },
    },
    {
      name: 'GET /api/cloud/status/ answers with a trailing slash',
      path: '/api/cloud/status/',
      expect: { status: 200, schema: UNLINKED_SUMMARY },
    },
    {
      name: 'HEAD /api/cloud/status answers the GET’s status with no body',
      method: 'HEAD',
      path: '/api/cloud/status',
      expect: { status: 200, headers: JSON_TYPE, body: '' },
    },
    {
      name: 'GET /api/cloud/link/status answers idle',
      path: '/api/cloud/link/status',
      expect: { status: 200, headers: JSON_TYPE, schema: LINK_IDLE },
    },
    {
      name: 'GET /api/cloud/link/status answers an agent the same',
      path: '/api/cloud/link/status',
      headers: AGENT,
      expect: { status: 200, schema: LINK_IDLE },
    },
    {
      name: 'POST /api/cloud/link/start refuses an agent',
      method: 'POST',
      path: '/api/cloud/link/start',
      headers: AGENT,
      expect: {
        status: 403,
        headers: JSON_TYPE,
        body: PERSON_ONLY_ERROR(
          'Only you can link this computer to a DorkOS account, from the DorkOS app.'
        ),
      },
    },
    {
      name: 'POST /api/cloud/link/cancel refuses an agent',
      method: 'POST',
      path: '/api/cloud/link/cancel',
      headers: AGENT,
      expect: {
        status: 403,
        body: PERSON_ONLY_ERROR(
          'Only you can stop linking this computer to a DorkOS account, from the DorkOS app.'
        ),
      },
    },
    {
      name: 'POST /api/cloud/link/cancel answers idle',
      method: 'POST',
      path: '/api/cloud/link/cancel',
      expect: { status: 200, schema: LINK_IDLE },
    },
    {
      name: 'POST /api/cloud/unlink refuses an agent',
      method: 'POST',
      path: '/api/cloud/unlink',
      headers: AGENT,
      expect: {
        status: 403,
        body: PERSON_ONLY_ERROR(
          'Only you can unlink this computer from its DorkOS account, from the DorkOS app.'
        ),
      },
    },
    {
      name: 'POST /api/cloud/link/check refuses an agent with an envelope',
      method: 'POST',
      path: '/api/cloud/link/check',
      headers: AGENT,
      expect: {
        status: 403,
        body: PERSON_ONLY_ENVELOPE(
          'Only you can check this computer’s DorkOS account link, from the DorkOS app.'
        ),
      },
    },
    {
      name: 'POST /api/cloud/link/check answers the unlinked summary',
      method: 'POST',
      path: '/api/cloud/link/check',
      expect: { status: 200, schema: UNLINKED_SUMMARY },
    },
    // cloud: the account reads, unlinked
    ...(
      [
        '/api/cloud/plan',
        '/api/cloud/usage',
        '/api/cloud/usage?groupBy=model',
        '/api/cloud/nudge',
        '/api/cloud/orgs',
        '/api/cloud/orgs/org-1/seats',
        '/api/cloud/orgs/org-1/members',
        '/api/cloud/offers',
      ] as const
    ).map((path): ContractCase => ({
      name: `GET ${path} answers unavailable while unlinked`,
      path,
      expect: { status: 200, headers: JSON_TYPE, body: UNAVAILABLE },
    })),
    {
      name: 'GET /api/cloud/usage refuses an unknown grouping',
      path: '/api/cloud/usage?groupBy=planet',
      expect: { status: 400, body: { error: 'Unknown grouping' } },
    },
    {
      name: 'GET /api/cloud/usage refuses a repeated grouping',
      path: '/api/cloud/usage?groupBy=seat&groupBy=day',
      expect: { status: 400, body: { error: 'Unknown grouping' } },
    },
    {
      name: 'GET /api/cloud/credits answers the credits status',
      path: '/api/cloud/credits',
      expect: { status: 200, headers: JSON_TYPE, schema: CREDITS },
    },
    // cloud: the writes, unlinked
    {
      name: 'POST /api/cloud/seats/:seatId/assign refuses an agent',
      method: 'POST',
      path: '/api/cloud/seats/seat-1/assign',
      headers: AGENT,
      body: { subject: { kind: 'user', id: 'u1' } },
      expect: {
        status: 403,
        body: PERSON_ONLY_ENVELOPE('Only you can change who holds a seat, from the DorkOS app.'),
      },
    },
    {
      name: 'POST /api/cloud/seats/:seatId/assign answers not linked before reading the body',
      method: 'POST',
      path: '/api/cloud/seats/seat-1/assign',
      body: { subject: { kind: 'robot' } },
      expect: { status: 200, body: NOT_LINKED },
    },
    {
      name: 'POST /api/cloud/seats/:seatId/release answers not linked',
      method: 'POST',
      path: '/api/cloud/seats/seat-1/release',
      expect: { status: 200, body: NOT_LINKED },
    },
    {
      name: 'POST /api/cloud/seats/:seatId/assign answers malformed JSON as a 500',
      method: 'POST',
      path: '/api/cloud/seats/seat-1/assign',
      headers: { 'content-type': 'application/json' },
      body: '{"subject":',
      expect: { status: 500, schema: MALFORMED_JSON },
    },
    {
      name: 'POST /api/cloud/billing/:page refuses an agent before naming the page',
      method: 'POST',
      path: '/api/cloud/billing/refunds',
      headers: AGENT,
      expect: {
        status: 403,
        body: PERSON_ONLY_ENVELOPE(
          'Only you can open billing for your DorkOS account, from the DorkOS app.'
        ),
      },
    },
    {
      name: 'POST /api/cloud/billing/:page answers 404 for an unknown page',
      method: 'POST',
      path: '/api/cloud/billing/refunds',
      expect: {
        status: 404,
        headers: { 'cache-control': null },
        body: { ok: false, message: 'Unknown billing page' },
      },
    },
    {
      name: 'POST /api/cloud/billing/checkout refuses no offer',
      method: 'POST',
      path: '/api/cloud/billing/checkout',
      body: {},
      expect: { status: 400, body: { ok: false, message: 'Choose an offer' } },
    },
    ...(['portal', 'topup'] as const).map((page): ContractCase => ({
      name: `POST /api/cloud/billing/${page} answers not linked, never cached`,
      method: 'POST',
      path: `/api/cloud/billing/${page}`,
      expect: { status: 200, headers: { ...JSON_TYPE, ...NO_STORE }, body: NOT_LINKED },
    })),
    {
      name: 'POST /api/cloud/billing/checkout answers not linked with an offer named',
      method: 'POST',
      path: '/api/cloud/billing/checkout',
      body: { skuId: 'sku-1' },
      expect: { status: 200, headers: NO_STORE, body: NOT_LINKED },
    },
    {
      name: 'POST /api/cloud/account/export refuses an agent, never cached',
      method: 'POST',
      path: '/api/cloud/account/export',
      headers: AGENT,
      expect: {
        status: 403,
        headers: NO_STORE,
        body: PERSON_ONLY_ENVELOPE(
          'Only you can export your DorkOS account’s data, from the DorkOS app.'
        ),
      },
    },
    {
      name: 'POST /api/cloud/account/export answers not linked',
      method: 'POST',
      path: '/api/cloud/account/export',
      expect: { status: 200, headers: NO_STORE, body: NOT_LINKED },
    },
    {
      name: 'POST /api/cloud/account/deletion refuses an agent, never cached',
      method: 'POST',
      path: '/api/cloud/account/deletion',
      headers: AGENT,
      expect: {
        status: 403,
        headers: NO_STORE,
        body: PERSON_ONLY_ENVELOPE(
          'Only you can delete your DorkOS account, from the DorkOS app while signed in.'
        ),
      },
    },
    {
      name: 'POST /api/cloud/account/deletion answers not linked',
      method: 'POST',
      path: '/api/cloud/account/deletion',
      expect: { status: 200, headers: NO_STORE, body: NOT_LINKED },
    },
    {
      name: 'PUT /api/cloud/credits/default refuses an agent',
      method: 'PUT',
      path: '/api/cloud/credits/default',
      headers: AGENT,
      body: { runtime: 'test-mode', useCredits: false },
      expect: {
        status: 403,
        body: PERSON_ONLY_ERROR(
          'Only you can choose what runs on your DorkOS credits, from the DorkOS app.'
        ),
      },
    },
    {
      name: 'PUT /api/cloud/credits/default refuses an empty body',
      method: 'PUT',
      path: '/api/cloud/credits/default',
      expect: { status: 400, body: { error: 'Name a runtime and whether to use credits.' } },
    },
    {
      name: 'PUT /api/cloud/credits/default refuses credits a runtime cannot run on',
      method: 'PUT',
      path: '/api/cloud/credits/default',
      body: { runtime: 'test-mode', useCredits: true },
      expect: { status: 400, schema: z.object({ error: z.string() }).strict() },
    },
    {
      name: 'PUT /api/cloud/credits/default answers the status for a change that changes nothing',
      method: 'PUT',
      path: '/api/cloud/credits/default',
      body: { runtime: 'test-mode', useCredits: false },
      expect: { status: 200, schema: CREDITS },
    },
    {
      name: 'POST /api/cloud/credits/undo-filled answers the status',
      method: 'POST',
      path: '/api/cloud/credits/undo-filled',
      expect: { status: 200, schema: CREDITS },
    },
    {
      name: 'POST /api/cloud/credits/notices/dismiss refuses an agent',
      method: 'POST',
      path: '/api/cloud/credits/notices/dismiss',
      headers: AGENT,
      body: { kind: 'offer' },
      expect: {
        status: 403,
        body: PERSON_ONLY_ERROR(
          'Only you can dismiss a note about your DorkOS credits, from the DorkOS app.'
        ),
      },
    },
    {
      name: 'POST /api/cloud/credits/notices/dismiss refuses an unknown notice',
      method: 'POST',
      path: '/api/cloud/credits/notices/dismiss',
      body: { kind: 'weather' },
      expect: { status: 400, body: { error: 'Name the notice to dismiss.' } },
    },
    {
      name: 'POST /api/cloud/credits/notices/dismiss settles a notice',
      method: 'POST',
      path: '/api/cloud/credits/notices/dismiss',
      body: { kind: 'offer' },
      expect: { status: 200, schema: CREDITS },
    },
    {
      name: 'GET /api/cloud/nope is the /api 404',
      path: '/api/cloud/nope',
      expect: { status: 404, body: NOT_FOUND },
    },
    {
      name: 'POST /api/cloud/status is the /api 404',
      method: 'POST',
      path: '/api/cloud/status',
      expect: { status: 404, body: NOT_FOUND },
    },
    {
      name: 'GET /api/cloud is the /api 404',
      path: '/api/cloud',
      expect: { status: 404, body: NOT_FOUND },
    },
    {
      name: 'GET /api/cloud/status refuses a foreign Host',
      path: '/api/cloud/status',
      headers: { host: 'evil.example.com' },
      expect: { status: 403, headers: JSON_TYPE },
    },
    {
      name: 'POST /api/cloud/link/start answers a foreign Origin with the CORS 500',
      method: 'POST',
      path: '/api/cloud/link/start',
      headers: { origin: 'https://evil.example.com' },
      expect: {
        status: 500,
        body: {
          error: 'Origin https://evil.example.com not allowed by CORS',
          code: 'INTERNAL_ERROR',
        },
      },
    },
    // hosted spaces, with spaces off and an official space configured
    {
      name: 'GET /api/cloud/communities refuses while spaces are off',
      path: '/api/cloud/communities',
      expect: { status: 404, headers: { 'cache-control': null }, body: SPACES_DISABLED },
    },
    {
      name: 'POST /api/cloud/communities refuses while spaces are off',
      method: 'POST',
      path: '/api/cloud/communities',
      body: { idempotencyKey: 'k', name: 'Space' },
      expect: { status: 404, body: SPACES_DISABLED },
    },
    {
      name: 'GET /api/cloud/communities/nope refuses while spaces are off',
      path: '/api/cloud/communities/nope/deeper',
      expect: { status: 404, body: SPACES_DISABLED },
    },
    {
      name: 'GET /api/cloud/communities/sign-in answers unavailable while unlinked, never cached',
      path: '/api/cloud/communities/sign-in',
      expect: { status: 200, headers: { ...JSON_TYPE, ...NO_STORE }, body: UNAVAILABLE },
    },
    {
      // The gate lets the official space's sign-in through for a GET alone.
      name: 'HEAD /api/cloud/communities/sign-in refuses while spaces are off, with no body',
      method: 'HEAD',
      path: '/api/cloud/communities/sign-in',
      expect: { status: 404, body: '' },
    },
    {
      name: 'POST /api/cloud/communities/sign-in refuses while spaces are off',
      method: 'POST',
      path: '/api/cloud/communities/sign-in',
      expect: { status: 404, body: SPACES_DISABLED },
    },
    // tunnel
    {
      name: 'GET /api/tunnel/status answers the tunnel’s state',
      path: '/api/tunnel/status',
      expect: { status: 200, headers: JSON_TYPE, schema: TUNNEL_STATUS },
    },
    {
      name: 'GET /api/tunnel/status/ answers with a trailing slash',
      path: '/api/tunnel/status/',
      expect: { status: 200, schema: TUNNEL_STATUS },
    },
    {
      name: 'HEAD /api/tunnel/status answers with no body',
      method: 'HEAD',
      path: '/api/tunnel/status',
      expect: { status: 200, headers: JSON_TYPE, body: '' },
    },
    {
      name: 'POST /api/tunnel/start refuses an agent',
      method: 'POST',
      path: '/api/tunnel/start',
      headers: AGENT,
      expect: { status: 403, schema: OPERATOR_ONLY },
    },
    {
      name: 'POST /api/tunnel/start refuses while login is off',
      method: 'POST',
      path: '/api/tunnel/start',
      expect: { status: 409, schema: EXPOSURE_NEEDS_LOGIN },
    },
    {
      name: 'POST /api/tunnel/stop runs no bar, even for an agent',
      method: 'POST',
      path: '/api/tunnel/stop',
      headers: AGENT,
      expect: { status: 200, body: { ok: true } },
    },
    {
      name: 'POST /api/tunnel/stop answers ok',
      method: 'POST',
      path: '/api/tunnel/stop',
      expect: { status: 200, headers: JSON_TYPE, body: { ok: true } },
    },
    {
      name: 'GET /api/tunnel/start is the /api 404',
      path: '/api/tunnel/start',
      expect: { status: 404, body: NOT_FOUND },
    },
    {
      name: 'GET /api/tunnel is the /api 404',
      path: '/api/tunnel',
      expect: { status: 404, body: NOT_FOUND },
    },
    // remote access
    {
      name: 'GET /api/remote-access/report answers the report',
      path: '/api/remote-access/report',
      expect: { status: 200, headers: JSON_TYPE, schema: REPORT },
    },
    {
      name: 'GET /api/remote-access/report/ answers with a trailing slash',
      path: '/api/remote-access/report/',
      expect: { status: 200, schema: REPORT },
    },
    {
      name: 'HEAD /api/remote-access/report answers with no body',
      method: 'HEAD',
      path: '/api/remote-access/report',
      expect: { status: 200, body: '' },
    },
    ...(['enrolment', 'mode', 'withdraw'] as const).map((action): ContractCase => ({
      name: `POST /api/remote-access/${action} refuses an agent`,
      method: 'POST',
      path: `/api/remote-access/${action}`,
      headers: AGENT,
      body: { mode: 'off' },
      expect: { status: 403, schema: OPERATOR_ONLY },
    })),
    {
      name: 'POST /api/remote-access/enrolment refuses while login is off',
      method: 'POST',
      path: '/api/remote-access/enrolment',
      expect: { status: 409, schema: EXPOSURE_NEEDS_LOGIN },
    },
    {
      name: 'POST /api/remote-access/mode refuses an unknown mode',
      method: 'POST',
      path: '/api/remote-access/mode',
      body: { mode: 'both' },
      expect: { status: 400, body: { error: 'Choose off, byo or managed.', code: 'INVALID_MODE' } },
    },
    {
      name: 'POST /api/remote-access/mode refuses no body',
      method: 'POST',
      path: '/api/remote-access/mode',
      expect: { status: 400, body: { error: 'Choose off, byo or managed.', code: 'INVALID_MODE' } },
    },
    {
      name: 'POST /api/remote-access/mode refuses managed while login is off',
      method: 'POST',
      path: '/api/remote-access/mode',
      body: { mode: 'managed' },
      expect: { status: 409, schema: EXPOSURE_NEEDS_LOGIN },
    },
    {
      name: 'POST /api/remote-access/mode turns remote access off',
      method: 'POST',
      path: '/api/remote-access/mode',
      body: { mode: 'off' },
      expect: { status: 200, schema: REPORT },
    },
    {
      name: 'POST /api/remote-access/close runs no bar, even for an agent',
      method: 'POST',
      path: '/api/remote-access/close',
      headers: AGENT,
      expect: { status: 200, schema: REPORT },
    },
    {
      name: 'POST /api/remote-access/withdraw answers the report',
      method: 'POST',
      path: '/api/remote-access/withdraw',
      expect: { status: 200, schema: REPORT },
    },
    {
      name: 'GET /api/remote-access/nope is the /api 404',
      path: '/api/remote-access/nope',
      expect: { status: 404, body: NOT_FOUND },
    },
    {
      name: 'GET /api/remote-access/enrolment is the /api 404',
      path: '/api/remote-access/enrolment',
      expect: { status: 404, body: NOT_FOUND },
    },
  ],
  { env: BASE_ENV }
);

/** A request against a hand-driven server, with the case fields that vary. */
type Ask = Omit<ContractCase, 'name'>;

/** Send one case to the server this file booted itself. */
async function check(server: ComposedServer | undefined, ask: Ask): Promise<void> {
  await checkContractCase(server!.baseUrl, { name: ask.path, ...ask });
}

/**
 * Send one setup request and return its JSON body and headers, failing loudly
 * when the server refuses it.
 */
async function setup(
  server: ComposedServer | undefined,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ json: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(new URL(url, server!.baseUrl), {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} answered ${res.status}: ${text.slice(0, 300)}`);
  return { json: text ? (JSON.parse(text) as Record<string, unknown>) : {}, headers: res.headers };
}

/** The first event-stream frame a server sends, its status and headers, then the stream closed. */
function firstFrame(
  server: ComposedServer | undefined,
  url: string
): Promise<{ status: number; headers: http.IncomingHttpHeaders; frame: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(new URL(url, server!.baseUrl), (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        text += chunk;
        const end = text.indexOf('\n\n');
        if (end === -1) return;
        resolve({ status: res.statusCode ?? 0, headers: res.headers, frame: text.slice(0, end) });
        req.destroy();
      });
      res.on('error', () => undefined);
    });
    req.on('error', (error) => {
      if (!req.destroyed) reject(error);
    });
  });
}

/** Poll until `ready` holds or the budget runs out. */
async function eventually(ready: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe('contract: the cloud and tunnel groups, driven by hand (login off)', () => {
  let server: ComposedServer | undefined;
  beforeAll(async () => {
    server = await bootComposedServer(BASE_ENV);
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
  }, 30_000);

  it('streams the tunnel’s status as an event stream, then lets the client go', async () => {
    const { status, headers, frame } = await firstFrame(server, '/api/tunnel/stream');
    expect(status).toBe(200);
    expect(headers['content-type']).toBe('text/event-stream');
    expect(headers['cache-control']).toBe('no-cache');
    expect(headers['x-content-type-options']).toBe('nosniff');
    const [event, data] = frame.split('\n');
    expect(event).toBe('event: tunnel_status');
    expect(TUNNEL_STATUS.parse(JSON.parse(data!.replace(/^data: /, '')))).toBeTruthy();
    // The server is still answering after the client left.
    await check(server, {
      path: '/api/tunnel/status',
      expect: { status: 200, schema: TUNNEL_STATUS },
    });
  });

  it('links the account through the approval page, reads it, and unlinks', async () => {
    const started = await setup(server, 'POST', '/api/cloud/link/start');
    expect(started.json).toMatchObject({ userCode: expect.any(String) });
    const userCode = started.json.userCode as string;
    await check(server, {
      path: '/api/cloud/link/status',
      expect: {
        status: 200,
        schema: z.object({ state: z.literal('pending'), pending: z.object({}).loose() }).loose(),
      },
    });
    // An agent sees the flow, never the code a person approves.
    await check(server, {
      path: '/api/cloud/link/status',
      headers: AGENT,
      expect: {
        status: 200,
        schema: z
          .object({ state: z.literal('pending') })
          .loose()
          .refine((body) => !('pending' in body)),
      },
    });
    const approved = await fetch(
      new URL(`/api/test/fake-cloud/approve?code=${encodeURIComponent(userCode)}`, server!.baseUrl)
    );
    expect(approved.status).toBe(200);
    await eventually(async () => {
      const res = await fetch(new URL('/api/cloud/status', server!.baseUrl));
      return ((await res.json()) as { linked?: boolean }).linked === true;
    }, 'the link');

    await check(server, {
      path: '/api/cloud/plan',
      expect: {
        status: 200,
        schema: z
          .object({ available: z.literal(true), entitlements: z.unknown(), balance: z.unknown() })
          .strict(),
      },
    });
    await check(server, {
      path: '/api/cloud/offers',
      expect: {
        status: 200,
        schema: z.object({ available: z.literal(true), offers: z.unknown() }).loose(),
      },
    });
    await check(server, {
      path: '/api/cloud/orgs',
      expect: { status: 200, body: { available: true, orgs: [] } },
    });
    await check(server, {
      path: '/api/cloud/nudge',
      expect: { status: 200, body: UNAVAILABLE },
    });
    // The fake serves no seats: an unwell service is a 502 that echoes nothing.
    await check(server, {
      path: '/api/cloud/orgs/org-1/seats',
      expect: {
        status: 502,
        headers: JSON_TYPE,
        body: { error: 'Could not reach the DorkOS cloud. Try again shortly.' },
      },
    });
    // Nor any billing page: a write answers 200 with one plain sentence.
    await check(server, {
      method: 'POST',
      path: '/api/cloud/billing/portal',
      expect: {
        status: 200,
        headers: NO_STORE,
        body: { ok: false, message: 'Couldn’t reach your DorkOS account. Try again shortly.' },
      },
    });
    await check(server, {
      method: 'POST',
      path: '/api/cloud/seats/seat-1/assign',
      body: { subject: { kind: 'robot' } },
      expect: { status: 400, body: { ok: false, message: 'Unknown subject' } },
    });
    await check(server, {
      method: 'POST',
      path: '/api/cloud/link/check',
      expect: { status: 200, schema: z.object({ linked: z.literal(true) }).loose() },
    });
    // With spaces off, the official space's sign-in is read from the account,
    // which the fake does not serve.
    await check(server, {
      path: '/api/cloud/communities/sign-in',
      expect: {
        status: 502,
        headers: NO_STORE,
        body: { error: 'Couldn’t reach your DorkOS account. Try again.' },
      },
    });
    await check(server, {
      method: 'POST',
      path: '/api/cloud/unlink',
      expect: { status: 200, body: { ok: true } },
    });
    await check(server, {
      path: '/api/cloud/status',
      expect: { status: 200, schema: UNLINKED_SUMMARY },
    });
  });

  it('answers the hosted spaces with spaces on', async () => {
    await setup(server, 'PATCH', '/api/config', { spaces: { enabled: true } });
    await check(server, {
      path: '/api/cloud/communities',
      expect: { status: 200, headers: NO_STORE, body: UNAVAILABLE },
    });
    await check(server, {
      path: '/api/cloud/communities/name-check?name=Not%20An%20Address',
      expect: { status: 400, headers: NO_STORE, body: { error: 'That isn’t a web address.' } },
    });
    await check(server, {
      path: '/api/cloud/communities/name-check?name=good-name',
      expect: { status: 200, body: UNAVAILABLE },
    });
    await check(server, {
      path: '/api/cloud/communities/moves/room?bytes=9',
      expect: { status: 200, body: SPACE_NOT_LINKED },
    });
    await check(server, {
      path: '/api/cloud/communities/moves/move-1',
      expect: { status: 200, body: UNAVAILABLE },
    });
    await check(server, {
      method: 'POST',
      path: '/api/cloud/communities',
      headers: AGENT,
      body: { idempotencyKey: 'k', name: 'Space' },
      expect: {
        status: 403,
        headers: NO_STORE,
        body: PERSON_ONLY_ENVELOPE(
          'Only you can start a space on your DorkOS account, from the DorkOS app.'
        ),
      },
    });
    await check(server, {
      method: 'POST',
      path: '/api/cloud/communities',
      body: { name: '' },
      expect: { status: 200, body: SPACE_NOT_LINKED },
    });
    await check(server, {
      method: 'POST',
      path: '/api/cloud/communities/moves?idempotencyKey=k&name=Space',
      headers: { ...AGENT, 'content-type': 'application/zip' },
      body: 'not really a zip',
      expect: {
        status: 403,
        body: PERSON_ONLY_ENVELOPE(
          'Only you can move a space to your DorkOS account, from the DorkOS app.'
        ),
      },
    });
    await check(server, {
      method: 'POST',
      path: '/api/cloud/communities/moves?idempotencyKey=k&name=Space',
      headers: { 'content-type': 'application/zip' },
      body: 'not really a zip',
      expect: { status: 200, body: SPACE_NOT_LINKED },
    });
    for (const url of [
      '/api/cloud/communities/moves/move-1/cancel',
      '/api/cloud/communities/moves/move-1/upload',
      '/api/cloud/communities/space-1/restore',
    ]) {
      await check(server, {
        method: 'POST',
        path: url,
        expect: { status: 200, body: SPACE_NOT_LINKED },
      });
    }
    await check(server, {
      method: 'POST',
      path: '/api/cloud/communities/space-1/claim-link',
      headers: AGENT,
      expect: {
        status: 403,
        body: PERSON_ONLY_ENVELOPE(
          'Only you can open the link that makes you a space’s owner, from the DorkOS app.'
        ),
      },
    });
    await check(server, {
      method: 'POST',
      path: '/api/cloud/communities/space-1/keep',
      body: {},
      expect: { status: 200, body: SPACE_NOT_LINKED },
    });
    // An unknown path inside the group is the /api 404, still never cached.
    await check(server, {
      path: '/api/cloud/communities/space-1/nope',
      expect: { status: 404, headers: NO_STORE, body: NOT_FOUND },
    });
    await check(server, {
      method: 'DELETE',
      path: '/api/cloud/communities',
      expect: { status: 404, headers: NO_STORE, body: NOT_FOUND },
    });
  });
});

/** A host name the server is told it answers to, which is not this computer. */
const PROXIED_HOST = 'dorkos.contract.example';

describe('contract: remote access, reached by a name that is not this computer', () => {
  let server: ComposedServer | undefined;
  let cookie: Record<string, string>;
  const OWNER = {
    email: `owner-${randomUUID().slice(0, 8)}@dork.test`,
    password: 'a-long-password-1',
  };
  beforeAll(async () => {
    server = await bootComposedServer({ ...BASE_ENV, DORKOS_TRUSTED_HOSTS: PROXIED_HOST });
    // An owner exists, and this computer still asks for no password: login is
    // "off" in the old sense, yet another device must sign in as that owner.
    const origin = { origin: server.baseUrl };
    await setup(server, 'POST', '/api/auth/sign-up/email', { ...OWNER, name: 'Owner' }, origin);
    // Signed in there, since a sign-in works only where it was made (DOR-2969).
    cookie = await signInAt(server.baseUrl, PROXIED_HOST, OWNER);
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
  }, 30_000);

  const remote = { host: PROXIED_HOST };
  const signedInRemote = () => ({ ...cookie, ...remote, origin: `http://${PROXIED_HOST}` });
  const AUTH_REQUIRED = z.object({ code: z.literal('AUTH_REQUIRED') }).loose();
  const NEEDS_THIS_COMPUTER = {
    error: 'Remote access can only be changed on the computer DorkOS runs on.',
    code: 'REMOTE_SETUP_NEEDS_THIS_COMPUTER',
  };

  it('asks another device with no session to sign in, with the this-computer password off', async () => {
    // ADR 261015-125850 rule 3: other devices always need a person session.
    for (const [method, path] of [
      ['POST', '/api/remote-access/enrolment'],
      ['POST', '/api/remote-access/mode'],
      ['POST', '/api/remote-access/withdraw'],
      ['POST', '/api/remote-access/close'],
      ['GET', '/api/remote-access/report'],
      ['GET', '/api/tunnel/status'],
      ['GET', '/api/cloud/status'],
      ['POST', '/api/tunnel/start'],
      ['POST', '/api/tunnel/stop'],
    ] as const) {
      await check(server, {
        method,
        path,
        headers: remote,
        ...(method === 'POST' ? { body: { mode: 'off' } } : {}),
        expect: { status: 401, headers: JSON_TYPE, schema: AUTH_REQUIRED },
      });
    }
  });

  it('refuses the owner signed in at another name every remote access change but the close', async () => {
    for (const action of ['enrolment', 'mode', 'withdraw']) {
      await check(server, {
        method: 'POST',
        path: `/api/remote-access/${action}`,
        headers: signedInRemote(),
        body: { mode: 'off' },
        expect: { status: 403, headers: JSON_TYPE, body: NEEDS_THIS_COMPUTER },
      });
    }
    await check(server, {
      method: 'POST',
      path: '/api/remote-access/close',
      headers: signedInRemote(),
      expect: { status: 200, schema: REPORT },
    });
  });

  it('answers the owner signed in at another name the reads, and the tunnel’s stop', async () => {
    await check(server, {
      path: '/api/remote-access/report',
      headers: signedInRemote(),
      expect: { status: 200, schema: REPORT },
    });
    await check(server, {
      path: '/api/tunnel/status',
      headers: signedInRemote(),
      expect: { status: 200, schema: TUNNEL_STATUS },
    });
    await check(server, {
      path: '/api/cloud/status',
      headers: signedInRemote(),
      expect: { status: 200, schema: UNLINKED_SUMMARY },
    });
    await check(server, {
      method: 'POST',
      path: '/api/tunnel/stop',
      headers: signedInRemote(),
      expect: { status: 200, body: { ok: true } },
    });
  });
});

describe('contract: the same groups with login on', () => {
  let server: ComposedServer | undefined;
  let cookie: Record<string, string>;
  let apiKey: Record<string, string>;
  const OWNER = {
    email: `owner-${randomUUID().slice(0, 8)}@dork.test`,
    password: 'a-long-password-1',
  };

  beforeAll(async () => {
    server = await bootComposedServer(BASE_ENV);
    const origin = { origin: server.baseUrl };
    await setup(server, 'POST', '/api/auth/sign-up/email', { ...OWNER, name: 'Owner' }, origin);
    await setup(server, 'PATCH', '/api/config', { auth: { enabled: true } });
    const signedIn = await setup(server, 'POST', '/api/auth/sign-in/email', OWNER, origin);
    cookie = {
      cookie: signedIn.headers
        .getSetCookie()
        .map((value) => value.split(';')[0]!)
        .join('; '),
    };
    const created = await setup(
      server,
      'POST',
      '/api/auth/api-key/create',
      { name: 'c' },
      { ...cookie, ...origin }
    );
    apiKey = { authorization: `Bearer ${created.json.key as string}` };
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
  }, 30_000);

  const AUTH_REQUIRED = z.object({ code: z.literal('AUTH_REQUIRED') }).loose();
  const COOKIE_REQUIRED = (subject: string) => ({
    error: `Only a person signed in to DorkOS can change ${subject}`,
    code: 'operator_cookie_required',
  });

  it('refuses a caller with no credential at the session gate', async () => {
    for (const [method, url] of [
      ['GET', '/api/cloud/status'],
      ['POST', '/api/cloud/link/start'],
      ['GET', '/api/cloud/communities/sign-in'],
      ['GET', '/api/tunnel/status'],
      ['GET', '/api/tunnel/stream'],
      ['POST', '/api/tunnel/stop'],
      ['GET', '/api/remote-access/report'],
      ['POST', '/api/remote-access/close'],
    ] as const) {
      await check(server, { method, path: url, expect: { status: 401, schema: AUTH_REQUIRED } });
    }
  });

  it('lets an API key read but not start a tunnel or change remote access', async () => {
    await check(server, {
      path: '/api/tunnel/status',
      headers: apiKey,
      expect: { status: 200, schema: TUNNEL_STATUS },
    });
    await check(server, {
      method: 'POST',
      path: '/api/tunnel/start',
      headers: apiKey,
      expect: { status: 403, body: COOKIE_REQUIRED('Remote Access') },
    });
    // The cookie bar runs before the agent bar.
    await check(server, {
      method: 'POST',
      path: '/api/tunnel/start',
      headers: { ...apiKey, ...AGENT },
      expect: { status: 403, body: COOKIE_REQUIRED('Remote Access') },
    });
    await check(server, {
      method: 'POST',
      path: '/api/tunnel/stop',
      headers: apiKey,
      expect: { status: 200, body: { ok: true } },
    });
    for (const action of ['enrolment', 'mode', 'withdraw']) {
      await check(server, {
        method: 'POST',
        path: `/api/remote-access/${action}`,
        headers: apiKey,
        body: { mode: 'off' },
        expect: { status: 403, body: COOKIE_REQUIRED('remote access') },
      });
    }
    await check(server, {
      method: 'POST',
      path: '/api/remote-access/close',
      headers: apiKey,
      expect: { status: 200, schema: REPORT },
    });
  });

  it('lets the owner’s cookie past the bars to the tunnel’s own settings', async () => {
    await check(server, {
      method: 'POST',
      path: '/api/tunnel/start',
      headers: { ...cookie, origin: server!.baseUrl },
      expect: { status: 400, body: { error: 'No ngrok auth token configured' } },
    });
    await check(server, {
      method: 'POST',
      path: '/api/tunnel/start',
      headers: { ...cookie, ...AGENT, origin: server!.baseUrl },
      expect: { status: 403, schema: OPERATOR_ONLY },
    });
    await check(server, {
      method: 'POST',
      path: '/api/remote-access/mode',
      headers: { ...cookie, origin: server!.baseUrl },
      body: { mode: 'off' },
      expect: { status: 200, schema: REPORT },
    });
  });

  it('keeps the account writes to the owner’s cookie, and the link code from an API key', async () => {
    await check(server, {
      method: 'POST',
      path: '/api/cloud/link/start',
      headers: apiKey,
      expect: {
        status: 403,
        schema: z
          .object({ code: z.enum(['person_only', 'owner_only']), error: z.string() })
          .strict(),
      },
    });
    await check(server, {
      method: 'POST',
      path: '/api/cloud/billing/portal',
      headers: apiKey,
      expect: {
        status: 403,
        schema: z
          .object({
            ok: z.literal(false),
            code: z.enum(['person_only', 'owner_only']),
            message: z.string(),
          })
          .strict(),
      },
    });
    await check(server, {
      method: 'POST',
      path: '/api/cloud/billing/portal',
      headers: { ...cookie, origin: server!.baseUrl },
      expect: { status: 200, headers: NO_STORE, body: NOT_LINKED },
    });
    await setup(server, 'POST', '/api/cloud/link/start', undefined, {
      ...cookie,
      origin: server!.baseUrl,
    });
    await check(server, {
      path: '/api/cloud/link/status',
      headers: cookie,
      expect: {
        status: 200,
        schema: z.object({ state: z.literal('pending'), pending: z.object({}).loose() }).loose(),
      },
    });
    await check(server, {
      path: '/api/cloud/link/status',
      headers: apiKey,
      expect: {
        status: 200,
        schema: z
          .object({ state: z.literal('pending') })
          .loose()
          .refine((body) => !('pending' in body)),
      },
    });
    await setup(server, 'POST', '/api/cloud/link/cancel', undefined, {
      ...cookie,
      origin: server!.baseUrl,
    });
  });
});
