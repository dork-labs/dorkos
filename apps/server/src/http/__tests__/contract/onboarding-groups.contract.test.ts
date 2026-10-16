/**
 * Contract for first-run setup (`/api/onboarding`), which moves to Hono in
 * DOR-2812: the pick on the Welcome screen (`POST /first-run`) and DorkBot's
 * welcome in #team (`POST /welcome`). That PR must pass this file unchanged.
 *
 * `POST /first-run` saves keys and moves the default runtime, so it sits
 * behind two bars: a caller at this computer, then a person who owns the
 * install. The welcome has only the second.
 *
 * Nothing here leaves the machine. A hosted preset (OpenAI and the rest) reads
 * its service's model list with the key, so the only hosted keys sent here are
 * ones DorkOS refuses before any read. The `local` preset reads Ollama on its
 * fixed port, which a developer's own Ollama may answer, so it is never picked.
 * A key is saved through the hand-typed (`custom`) choice, which stores it
 * without reading anything.
 *
 * Two servers:
 *
 * 1. Login off: every answer and refusal, in order. Each pick undoes the one
 *    before it, and the last case finishes the first run, after which a pick
 *    is refused.
 * 2. Login on: no credential is refused at the session gate; an API key is not
 *    a person; the owner's cookie may set DorkOS up, but only at this computer.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { z } from 'zod';
import {
  BOOT_HOOK_TIMEOUT_MS,
  bootComposedServer,
  checkContractCase,
  contractSuite,
  type ComposedServer,
  type ContractCase,
} from './harness.js';

/** A host name the server is told it answers to, which is not this computer. */
const REMOTE_HOST = 'dorkos.contract.example';
/** No Cloud is reached, and the remote host is trusted. */
const BASE_ENV = {
  DORKOS_CLOUD_URL: 'http://127.0.0.1:9',
  NGROK_AUTHTOKEN: '',
  DORKOS_TRUSTED_HOSTS: REMOTE_HOST,
};

const JSON_TYPE = { 'content-type': /^application\/json\b/ };
const NOT_FOUND = { error: 'Not found', code: 'API_NOT_FOUND' };
/** An agent header this machine never minted: the caller is a machine, unverified. */
const AGENT = { 'X-DorkOS-Agent': 'not-a-real-token' };
const NOT_HERE = { error: 'Setup is only available on this computer.' };
/**
 * The session gate's 401. Another device needs a person session even with the
 * this-computer password off (ADR 261015-125850 rule 3); the route's own
 * answers to a signed-in caller at another name are in the login-on suite.
 */
const GATE_REFUSED = z.object({ code: z.literal('AUTH_REQUIRED') }).loose();
const SETUP_REFUSED = (code: string) => ({ error: 'Only the owner can set up DorkOS.', code });
const CHOOSE = { error: 'Choose how your agents run.' };
const MALFORMED_JSON = z.object({ code: z.literal('INTERNAL_ERROR') }).loose();
const TOO_LARGE = {
  error: 'That is too large to send in one request.',
  code: 'REQUEST_TOO_LARGE',
};
const FINISHED = { error: 'Setup is already finished.', code: 'onboarding_complete' };
const WELCOME = z.object({ roomId: z.string().min(1), entryId: z.string().min(1) }).strict();
/** Above the app-wide 1 MB limit. */
const OVERSIZE = JSON.stringify({ padding: 'x'.repeat(1_500_000) });

/** A hand-typed setup for a service at an address nothing listens on. */
const CUSTOM_API_KEY = {
  source: 'api-key',
  provider: 'contract',
  protocol: 'openai-chat-completions',
  endpoint: 'http://127.0.0.1:9/v1',
  model: 'contract-model',
  contextWindow: 32_000,
  maxOutputTokens: 4_000,
} as const;
/** A hand-typed setup for a model on this computer. */
const CUSTOM_LOCAL = {
  ...CUSTOM_API_KEY,
  source: 'local',
  provider: 'contract-local',
  model: 'contract-local-model',
} as const;
/** What the DorkOS model setup reads back after the hand-typed key was saved. */
const SAVED_KEY = z
  .object({
    inference: z
      .object({ source: z.literal('api-key'), model: z.literal('contract-model') })
      .loose(),
    hasKey: z.literal(true),
  })
  .loose();
const SAVED_LOCAL = z
  .object({
    inference: z
      .object({ source: z.literal('local'), model: z.literal('contract-local-model') })
      .loose(),
    hasKey: z.literal(false),
  })
  .loose();

/** A first-run pick. */
function pick(name: string, body: unknown, expect: ContractCase['expect']): ContractCase {
  return { name, method: 'POST', path: '/api/onboarding/first-run', body, expect };
}

contractSuite(
  'first-run setup (/api/onboarding)',
  [
    // The bars, before anything is read or written.
    {
      name: 'POST /api/onboarding/first-run asks a caller at another name to sign in, with login off',
      method: 'POST',
      path: '/api/onboarding/first-run',
      headers: { host: REMOTE_HOST },
      body: { path: 'none' },
      expect: { status: 401, headers: JSON_TYPE, schema: GATE_REFUSED },
    },
    {
      name: 'POST /api/onboarding/first-run asks a caller at another name to sign in before its body',
      method: 'POST',
      path: '/api/onboarding/first-run',
      headers: { host: REMOTE_HOST, ...AGENT },
      body: { path: 'nowhere' },
      expect: { status: 401, schema: GATE_REFUSED },
    },
    {
      name: 'POST /api/onboarding/first-run refuses a foreign host',
      method: 'POST',
      path: '/api/onboarding/first-run',
      headers: { host: 'evil.example' },
      body: { path: 'none' },
      expect: {
        status: 403,
        headers: JSON_TYPE,
        schema: z.object({ code: z.literal('HOST_NOT_ALLOWED') }).loose(),
      },
    },
    {
      name: 'POST /api/onboarding/first-run refuses an agent, whatever it picked',
      method: 'POST',
      path: '/api/onboarding/first-run',
      headers: AGENT,
      body: { path: 'none' },
      expect: { status: 403, headers: JSON_TYPE, body: SETUP_REFUSED('not-a-person') },
    },
    {
      name: 'POST /api/onboarding/first-run refuses an approval token',
      method: 'POST',
      path: '/api/onboarding/first-run',
      headers: { 'X-DorkOS-Approval': 'abc' },
      body: { path: 'none' },
      expect: { status: 403, body: SETUP_REFUSED('not-a-person') },
    },
    {
      name: 'POST /api/onboarding/first-run refuses an agent before its body',
      method: 'POST',
      path: '/api/onboarding/first-run',
      headers: AGENT,
      body: { path: 'nowhere' },
      expect: { status: 403, body: SETUP_REFUSED('not-a-person') },
    },
    {
      name: 'POST /api/onboarding/welcome refuses an agent',
      method: 'POST',
      path: '/api/onboarding/welcome',
      headers: AGENT,
      expect: { status: 403, headers: JSON_TYPE, body: SETUP_REFUSED('not-a-person') },
    },
    {
      name: 'POST /api/onboarding/welcome refuses an approval token',
      method: 'POST',
      path: '/api/onboarding/welcome',
      headers: { 'X-DorkOS-Approval': 'abc' },
      expect: { status: 403, body: SETUP_REFUSED('not-a-person') },
    },
    // What the body must be.
    {
      name: 'POST /api/onboarding/first-run refuses no body at all',
      method: 'POST',
      path: '/api/onboarding/first-run',
      expect: { status: 400, headers: JSON_TYPE, body: CHOOSE },
    },
    {
      name: 'POST /api/onboarding/first-run refuses an empty object',
      method: 'POST',
      path: '/api/onboarding/first-run',
      body: {},
      expect: { status: 400, body: CHOOSE },
    },
    {
      name: 'POST /api/onboarding/first-run refuses a body that is not an object',
      method: 'POST',
      path: '/api/onboarding/first-run',
      body: [1],
      expect: { status: 400, body: CHOOSE },
    },
    {
      name: 'POST /api/onboarding/first-run reads no body that is not sent as JSON',
      method: 'POST',
      path: '/api/onboarding/first-run',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ path: 'none' }),
      expect: { status: 400, body: CHOOSE },
    },
    {
      name: 'POST /api/onboarding/first-run refuses a path it does not know',
      method: 'POST',
      path: '/api/onboarding/first-run',
      body: { path: 'nowhere' },
      expect: { status: 400, body: CHOOSE },
    },
    {
      name: 'POST /api/onboarding/first-run refuses a field the path does not take',
      method: 'POST',
      path: '/api/onboarding/first-run',
      body: { path: 'none', extra: true },
      expect: { status: 400, body: CHOOSE },
    },
    pick(
      'POST /api/onboarding/first-run refuses a key service with no key',
      { path: 'own', choice: { kind: 'openai' } },
      { status: 400, body: CHOOSE }
    ),
    pick(
      'POST /api/onboarding/first-run refuses a choice it does not know',
      { path: 'own', choice: { kind: 'nowhere' } },
      { status: 400, body: CHOOSE }
    ),
    pick(
      'POST /api/onboarding/first-run refuses a hand-typed setup with a bad endpoint',
      {
        path: 'own',
        choice: { kind: 'custom', inference: { ...CUSTOM_API_KEY, endpoint: 'not a url' } },
      },
      { status: 400, body: CHOOSE }
    ),
    pick(
      'POST /api/onboarding/first-run refuses a hand-typed key reference',
      {
        path: 'own',
        choice: {
          kind: 'custom',
          inference: { ...CUSTOM_API_KEY, credentialRef: 'file:x' },
          apiKey: 'sk-contract',
        },
      },
      { status: 400, body: CHOOSE }
    ),
    {
      name: 'POST /api/onboarding/first-run refuses malformed JSON in the chain',
      method: 'POST',
      path: '/api/onboarding/first-run',
      headers: { 'content-type': 'application/json' },
      body: '{bad',
      expect: { status: 500, schema: MALFORMED_JSON },
    },
    {
      name: 'POST /api/onboarding/first-run refuses a body above the app-wide limit',
      method: 'POST',
      path: '/api/onboarding/first-run',
      headers: { 'content-type': 'application/json' },
      body: OVERSIZE,
      expect: { status: 413, headers: JSON_TYPE, body: TOO_LARGE },
    },
    // Keys DorkOS refuses before reading any service.
    pick(
      'POST /api/onboarding/first-run refuses a subscription token as a key',
      { path: 'own', choice: { kind: 'anthropic', apiKey: 'sk-ant-oat01-contract' } },
      {
        status: 400,
        headers: JSON_TYPE,
        body: {
          error: 'Anthropic subscription tokens cannot run DorkOS agents. Use an API key.',
          code: 'invalid_key',
        },
      }
    ),
    pick(
      'POST /api/onboarding/first-run refuses a key of blanks',
      { path: 'own', choice: { kind: 'openai', apiKey: '   ' } },
      { status: 400, body: { error: 'Enter an API key.', code: 'invalid_key' } }
    ),
    pick(
      'POST /api/onboarding/first-run refuses a hand-typed hosted setup with no key',
      { path: 'own', choice: { kind: 'custom', inference: CUSTOM_API_KEY } },
      { status: 400, body: { error: 'Enter an API key.', code: 'invalid_key' } }
    ),
    pick(
      'POST /api/onboarding/first-run refuses a hand-typed subscription token',
      {
        path: 'own',
        choice: { kind: 'custom', inference: CUSTOM_API_KEY, apiKey: 'sk-ant-oat01-contract' },
      },
      {
        status: 400,
        body: {
          error: 'Anthropic subscription tokens cannot run DorkOS agents. Use an API key.',
          code: 'invalid_key',
        },
      }
    ),
    {
      name: 'a refused key changed nothing: the DorkOS model setup is still empty',
      path: '/api/runtimes/doe/inference',
      expect: { status: 200, body: { inference: null, hasKey: false, autoProtocol: null } },
    },
    // The picks, each undoing the one before.
    pick(
      'POST /api/onboarding/first-run saves a hand-typed key and moves new chats to DorkOS',
      {
        path: 'own',
        choice: { kind: 'custom', inference: CUSTOM_API_KEY, apiKey: 'sk-contract-key' },
      },
      {
        status: 200,
        headers: JSON_TYPE,
        body: { path: 'own', runtime: 'doe', model: 'contract-model' },
      }
    ),
    {
      name: 'the saved key shows in the DorkOS model setup',
      path: '/api/runtimes/doe/inference',
      expect: { status: 200, schema: SAVED_KEY },
    },
    {
      name: 'POST /api/onboarding/first-run/ answers with a trailing slash',
      method: 'POST',
      path: '/api/onboarding/first-run/',
      body: { path: 'own', choice: { kind: 'custom', inference: CUSTOM_LOCAL } },
      expect: {
        status: 200,
        body: { path: 'own', runtime: 'doe', model: 'contract-local-model' },
      },
    },
    {
      name: 'the hand-typed local model shows in the DorkOS model setup',
      path: '/api/runtimes/doe/inference',
      expect: { status: 200, schema: SAVED_LOCAL },
    },
    pick(
      'POST /api/onboarding/first-run with an AI app puts the default runtime back',
      { path: 'own', choice: { kind: 'agent-app' } },
      { status: 200, body: { path: 'own', runtime: 'claude-code' } }
    ),
    pick(
      'POST /api/onboarding/first-run with no AI answers the runtime left in place',
      { path: 'none' },
      { status: 200, body: { path: 'none', runtime: 'claude-code' } }
    ),
    pick(
      'POST /api/onboarding/first-run with DorkOS moves new chats to DorkOS',
      { path: 'dorkos' },
      { status: 200, body: { path: 'dorkos', runtime: 'doe' } }
    ),
    {
      name: 'the DorkOS pick cleared the hand-typed model setup',
      path: '/api/runtimes/doe/inference',
      expect: { status: 200, body: { inference: null, hasKey: false, autoProtocol: null } },
    },
    // The welcome.
    {
      name: 'POST /api/onboarding/welcome posts DorkBot’s welcome',
      method: 'POST',
      path: '/api/onboarding/welcome',
      expect: { status: 200, headers: JSON_TYPE, schema: WELCOME },
    },
    {
      name: 'POST /api/onboarding/welcome asks a caller at another name to sign in, with login off',
      method: 'POST',
      path: '/api/onboarding/welcome',
      headers: { host: REMOTE_HOST },
      expect: { status: 401, schema: GATE_REFUSED },
    },
    {
      name: 'POST /api/onboarding/welcome ignores a body',
      method: 'POST',
      path: '/api/onboarding/welcome',
      body: { anything: true },
      expect: { status: 200, schema: WELCOME },
    },
    // Paths the group does not serve.
    {
      name: 'GET /api/onboarding/first-run is the /api 404',
      path: '/api/onboarding/first-run',
      expect: { status: 404, headers: JSON_TYPE, body: NOT_FOUND },
    },
    {
      name: 'GET /api/onboarding/welcome is the /api 404',
      path: '/api/onboarding/welcome',
      expect: { status: 404, body: NOT_FOUND },
    },
    {
      name: 'PUT /api/onboarding/first-run is the /api 404',
      method: 'PUT',
      path: '/api/onboarding/first-run',
      body: { path: 'none' },
      expect: { status: 404, body: NOT_FOUND },
    },
    {
      name: 'GET /api/onboarding is the /api 404',
      path: '/api/onboarding',
      expect: { status: 404, body: NOT_FOUND },
    },
    {
      name: 'POST /api/onboarding/nope is the /api 404',
      method: 'POST',
      path: '/api/onboarding/nope',
      body: {},
      expect: { status: 404, body: NOT_FOUND },
    },
    // Finished: no pick after it.
    {
      name: 'finishing the first run (a person’s write to the settings)',
      method: 'PATCH',
      path: '/api/config',
      body: { onboarding: { completedAt: '2026-10-01T00:00:00.000Z' } },
      expect: { status: 200 },
    },
    pick(
      'POST /api/onboarding/first-run refuses a pick once the first run is finished',
      { path: 'none' },
      { status: 409, headers: JSON_TYPE, body: FINISHED }
    ),
    pick(
      'POST /api/onboarding/first-run checks a key before it says the first run is finished',
      { path: 'own', choice: { kind: 'openai', apiKey: '   ' } },
      { status: 409, body: FINISHED }
    ),
    {
      name: 'POST /api/onboarding/welcome still answers the welcome it posted',
      method: 'POST',
      path: '/api/onboarding/welcome',
      expect: { status: 200, schema: WELCOME },
    },
  ],
  { env: BASE_ENV }
);

/** Send one case to a hand-driven server. */
async function check(server: ComposedServer | undefined, ask: Omit<ContractCase, 'name'>) {
  await checkContractCase(server!.baseUrl, { name: ask.path, ...ask });
}

/** One setup request; throws on anything but a 2xx. */
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

describe('contract: first-run setup with login on', () => {
  let server: ComposedServer | undefined;
  let cookie: Record<string, string>;
  let apiKey: Record<string, string>;
  let origin: Record<string, string>;
  const OWNER = {
    email: `owner-${randomUUID().slice(0, 8)}@dork.test`,
    password: 'a-long-password-1',
  };

  beforeAll(async () => {
    server = await bootComposedServer(BASE_ENV);
    origin = { origin: server.baseUrl };
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

  it('refuses a caller with no credential at the session gate', async () => {
    for (const path of ['/api/onboarding/first-run', '/api/onboarding/welcome']) {
      await check(server, {
        method: 'POST',
        path,
        body: { path: 'none' },
        expect: { status: 401, schema: AUTH_REQUIRED },
      });
    }
  });

  it('refuses an API key, which is not a person', async () => {
    await check(server, {
      method: 'POST',
      path: '/api/onboarding/first-run',
      headers: { ...apiKey, ...origin },
      body: { path: 'none' },
      expect: { status: 403, body: SETUP_REFUSED('not-a-person') },
    });
    await check(server, {
      method: 'POST',
      path: '/api/onboarding/welcome',
      headers: { ...apiKey, ...origin },
      expect: { status: 403, body: SETUP_REFUSED('not-a-person') },
    });
  });

  it('refuses the owner’s cookie at another name, but only for the pick', async () => {
    await check(server, {
      method: 'POST',
      path: '/api/onboarding/first-run',
      headers: { ...cookie, host: REMOTE_HOST, origin: `http://${REMOTE_HOST}` },
      body: { path: 'none' },
      expect: { status: 403, body: NOT_HERE },
    });
    await check(server, {
      method: 'POST',
      path: '/api/onboarding/welcome',
      headers: { ...cookie, host: REMOTE_HOST, origin: `http://${REMOTE_HOST}` },
      expect: { status: 200, schema: WELCOME },
    });
  });

  it('lets the owner’s cookie pick and post the welcome', async () => {
    await check(server, {
      method: 'POST',
      path: '/api/onboarding/first-run',
      headers: { ...cookie, ...origin },
      body: { path: 'nowhere' },
      expect: { status: 400, body: CHOOSE },
    });
    await check(server, {
      method: 'POST',
      path: '/api/onboarding/first-run',
      headers: { ...cookie, ...origin },
      body: { path: 'none' },
      expect: { status: 200, body: { path: 'none', runtime: 'claude-code' } },
    });
    await check(server, {
      method: 'POST',
      path: '/api/onboarding/welcome',
      headers: { ...cookie, ...origin },
      expect: { status: 200, schema: WELCOME },
    });
  });
});
