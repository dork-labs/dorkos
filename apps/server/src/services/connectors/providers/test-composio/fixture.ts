/** Offline upstream for real Composio clients. Loaded only by the test-runtime bootstrap. */
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { ApiEnv } from '../../../../http/api-chain.js';
import { readJsonBody } from '../../../../http/request-body.js';
import { stableStringify } from '@dorkos/shared/capabilities';
import { legacyDefaultProviderInstanceId } from '../../legacy-connection-migration.js';
import {
  COMPOSIO_FIXTURE_DESCRIPTION,
  COMPOSIO_FIXTURE_LOGO,
  COMPOSIO_FIXTURE_KEY,
  COMPOSIO_FIXTURE_USER,
  COMPOSIO_FIXTURE_VERSION,
  COMPOSIO_FIXTURE_WEBHOOK_SECRET,
  COMPOSIO_FIXTURE_EVENTS,
  fixtureDefinitions,
  fixtureOperation,
  fixtureOperations,
} from './data.js';

const accountInput = z
  .object({
    auth_config: z.object({ id: z.literal('ac_offline_gmail') }).strict(),
    connection: z
      .object({ user_id: z.literal(COMPOSIO_FIXTURE_USER), alias: z.string().max(200).optional() })
      .strict(),
  })
  .strict();
const legacyTriggerConfig = z
  .record(z.string().min(1).max(200), z.string().max(200))
  .refine((filter) => Object.keys(filter).length <= 20);
const gmailTriggerConfig = z
  .object({
    interval: z.number().finite(),
    labelIds: z.string().max(200),
    query: z.string().max(200),
    userId: z.string().max(200),
  })
  .strict();
const triggerInput = z
  .object({
    connected_account_id: z.string(),
    user_id: z.literal(COMPOSIO_FIXTURE_USER),
    toolkit_versions: z.object({ gmail: z.literal(COMPOSIO_FIXTURE_VERSION) }).strict(),
    trigger_config: z.union([legacyTriggerConfig, gmailTriggerConfig]),
  })
  .strict();
const emitInput = z
  .object({
    accountOrdinal: z.number().int().min(1).max(100),
    eventType: z.enum(COMPOSIO_FIXTURE_EVENTS),
    eventId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    signature: z.enum(['valid', 'invalid']),
  })
  .strict();
/** A query string as the clients' requests carry it: a repeated key is a list. */
type Query = Record<string, string | string[] | undefined>;

/** The query string, each key literal (`toolkit_versions[gmail]` is one key). */
function queryOf(c: Context): Query {
  const query: Query = {};
  for (const [key, values] of Object.entries(c.req.queries())) {
    query[key] = values.length === 1 ? values[0] : values;
  }
  return query;
}

/** The most an offline upstream request body may carry. */
const BODY_LIMIT = 16 * 1024;

/**
 * A JSON request body, or `undefined` when there is none, it is not JSON, or
 * it is larger than {@link BODY_LIMIT}; every route refuses that as a `400`.
 */
async function jsonBody(c: Context): Promise<unknown> {
  if (!c.req.header('content-type')?.includes('json')) return undefined;
  const text = await c.req.text();
  if (Buffer.byteLength(text) > BODY_LIMIT) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A refused upstream request. */
const BAD_REQUEST = (c: Context): Response => c.text('Bad Request', 400);

type Account = {
  id: string;
  uuid: string;
  ordinal: number;
  alias?: string;
  status: 'INITIATED' | 'ACTIVE';
  user_id: string;
  toolkit: { slug: string };
};
type Trigger = {
  id: string;
  uuid: string;
  connected_account_id: string;
  connected_account_uuid: string;
  user_id: string;
  trigger_name: string;
  version: string;
  trigger_config: Record<string, string | number>;
  disabled_at: string | null;
};

/** Start one owned loopback listener; every upstream route is synthetic and never forwards. */
export async function startTestComposioFixture(options: {
  testRuntime: boolean;
  localOrigin: string;
}) {
  if (!options.testRuntime) throw new Error('Offline service requires test runtime.');
  const destination = new URL(options.localOrigin);
  if (
    destination.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(destination.hostname) ||
    destination.pathname !== '/' ||
    destination.search ||
    destination.hash ||
    destination.username ||
    destination.password
  ) {
    throw new Error('Offline event destination must be this server loopback origin.');
  }
  const ingressUrl = new URL(
    `/api/connectors/webhooks/${encodeURIComponent(legacyDefaultProviderInstanceId('composio'))}`,
    destination
  );
  const accounts = new Map<string, Account>();
  const triggers = new Map<string, Trigger>();
  let mode: 'ready' | 'unavailable' = 'ready';
  let ordinal = 0;
  let upstreamRequests = 0;
  let mutations = 0;
  let baseUrl = '';
  const app = new Hono();
  app.get('/consent/:id', (c) => {
    if (!accounts.has(c.req.param('id'))) return c.text('Not Found', 404);
    return c.html(
      '<!doctype html><html lang="en"><title>Offline Gmail consent</title><body><h1>Connect test Gmail</h1><form method="post"><button type="submit">Allow test Gmail</button></form></body></html>'
    );
  });
  app.post('/consent/:id', (c) => {
    const account = accounts.get(c.req.param('id'));
    if (!account) return c.text('Not Found', 404);
    account.status = 'ACTIVE';
    return c.html(
      '<!doctype html><html lang="en"><title>Connected</title><body><p>Test Gmail connected. You may close this window.</p></body></html>'
    );
  });
  app.use(async (c, next) => {
    upstreamRequests++;
    if (c.req.header('x-api-key') !== COMPOSIO_FIXTURE_KEY)
      return c.json({ error: { message: 'Offline project key required', status: 401 } }, 401);
    await next();
  });
  const page = (items: unknown[]) => ({ items, current_page: 1, total_pages: 1 });
  const versionMatches = (query: Query) =>
    query['toolkit_versions[gmail]'] === COMPOSIO_FIXTURE_VERSION;
  const listMatches = (query: Query, key: string, value: string) =>
    query[key] === value || query[`${key}[]`] === value;
  const toolkit = {
    slug: 'gmail',
    name: 'Gmail',
    auth_schemes: ['OAUTH2'],
    no_auth: false,
    meta: {
      version: COMPOSIO_FIXTURE_VERSION,
      description: COMPOSIO_FIXTURE_DESCRIPTION,
      logo: COMPOSIO_FIXTURE_LOGO,
    },
  };
  app.get('/api/v3.1/toolkits', (c) => c.json(page([toolkit])));
  app.get('/api/v3.1/toolkits/gmail', (c) => c.json(toolkit));
  app.get('/api/v3.1/auth_configs', (c) => {
    if (queryOf(c).toolkit_slug !== 'gmail') return BAD_REQUEST(c);
    return c.json(page([{ id: 'ac_offline_gmail', is_disabled: false }]));
  });
  app.post('/api/v3.1/connected_accounts', async (c) => {
    const input = accountInput.safeParse(await jsonBody(c));
    if (!input.success || accounts.size >= 100) return BAD_REQUEST(c);
    const id = `ca_${randomUUID()}`;
    const account: Account = {
      id,
      uuid: randomUUID(),
      ordinal: ++ordinal,
      status: 'INITIATED',
      user_id: COMPOSIO_FIXTURE_USER,
      toolkit: { slug: 'gmail' },
      ...(input.data.connection.alias && { alias: input.data.connection.alias }),
    };
    accounts.set(id, account);
    mutations++;
    return c.json({ id, status: account.status, redirect_url: `${baseUrl}/consent/${id}` });
  });
  app.get('/api/v3.1/connected_accounts', (c) => {
    const query = queryOf(c);
    if (
      !listMatches(query, 'user_ids', COMPOSIO_FIXTURE_USER) ||
      (query.toolkit_slugs && query.toolkit_slugs !== 'gmail')
    )
      return BAD_REQUEST(c);
    return c.json(page([...accounts.values()]));
  });
  app.get('/api/v3.1/connected_accounts/:id', (c) => {
    const account = accounts.get(c.req.param('id'));
    if (!account) return c.text('Not Found', 404);
    return c.json(account);
  });
  app.delete('/api/v3.1/connected_accounts/:id', (c) => {
    if (!accounts.delete(c.req.param('id'))) return c.text('Not Found', 404);
    mutations++;
    return c.json({ success: true });
  });
  app.get('/api/v3.1/tools', (c) => {
    const query = queryOf(c);
    if (query.toolkit_slug !== 'gmail' || !versionMatches(query)) return BAD_REQUEST(c);
    return c.json(page(fixtureOperations()));
  });
  app.get('/api/v3.1/tools/GMAIL_FETCH_EMAILS', (c) => {
    if (queryOf(c).version !== COMPOSIO_FIXTURE_VERSION) return BAD_REQUEST(c);
    return c.json(fixtureOperation());
  });
  app.post('/api/v3.1/tools/execute/GMAIL_FETCH_EMAILS', async (c) => {
    const input = z
      .object({
        connected_account_id: z.string(),
        user_id: z.literal(COMPOSIO_FIXTURE_USER),
        version: z.literal(COMPOSIO_FIXTURE_VERSION),
        arguments: z.object({}).strict(),
        allow_tracing: z.literal(false),
      })
      .strict()
      .safeParse(await jsonBody(c));
    const account = input.success && accounts.get(input.data.connected_account_id);
    if (!input.success || !account || account.status !== 'ACTIVE') return BAD_REQUEST(c);
    return c.json({
      successful: true,
      error: null,
      data: { messages: [{ subject: `Offline Gmail account ${account.ordinal}` }] },
      log_id: 'offline_execution',
    });
  });
  app.get('/api/v3.1/triggers_types', (c) => {
    const query = queryOf(c);
    if (!listMatches(query, 'toolkit_slugs', 'gmail') || !versionMatches(query))
      return BAD_REQUEST(c);
    return c.json(page(fixtureDefinitions()));
  });
  app.get('/api/v3.1/triggers_types/:slug', (c) => {
    const definition = fixtureDefinitions().find((item) => item.slug === c.req.param('slug'));
    if (!definition || !versionMatches(queryOf(c))) return BAD_REQUEST(c);
    return c.json(definition);
  });
  app.get('/api/v3.1/trigger_instances/active', (c) => {
    if (mode === 'unavailable') return c.text('Service Unavailable', 503);
    const query = queryOf(c);
    const account = [...accounts.values()].find((item) =>
      listMatches(query, 'connected_account_ids', item.id)
    );
    const event = COMPOSIO_FIXTURE_EVENTS.find((item) => listMatches(query, 'trigger_names', item));
    if (
      !account ||
      account.status !== 'ACTIVE' ||
      !event ||
      !listMatches(query, 'user_ids', COMPOSIO_FIXTURE_USER) ||
      query.show_disabled !== 'true'
    )
      return BAD_REQUEST(c);
    return c.json(
      page(
        [...triggers.values()].filter(
          (item) => item.connected_account_id === account.id && item.trigger_name === event
        )
      )
    );
  });
  app.post('/api/v3.1/trigger_instances/:slug/upsert', async (c) => {
    const slug = c.req.param('slug');
    const input = triggerInput.safeParse(await jsonBody(c));
    const account = input.success && accounts.get(input.data.connected_account_id);
    if (
      !input.success ||
      !account ||
      account.status !== 'ACTIVE' ||
      !COMPOSIO_FIXTURE_EVENTS.some((item) => item === slug) ||
      (slug === 'GMAIL_NEW_GMAIL_MESSAGE'
        ? !gmailTriggerConfig.safeParse(input.data.trigger_config).success
        : !legacyTriggerConfig.safeParse(input.data.trigger_config).success ||
          (slug !== 'GMAIL_UNSUPPORTED_FILTER' &&
            Object.keys(input.data.trigger_config).some((key) => key !== 'label')))
    )
      return BAD_REQUEST(c);
    if (mode === 'unavailable') return c.text('Service Unavailable', 503);
    const existing = [...triggers.values()].find(
      (item) =>
        item.connected_account_id === account.id &&
        item.trigger_name === slug &&
        stableStringify(item.trigger_config) === stableStringify(input.data.trigger_config)
    );
    const trigger: Trigger = existing ?? {
      id: `tr_${randomUUID()}`,
      uuid: randomUUID(),
      connected_account_id: account.id,
      connected_account_uuid: account.uuid,
      user_id: COMPOSIO_FIXTURE_USER,
      trigger_name: slug,
      version: COMPOSIO_FIXTURE_VERSION,
      trigger_config: input.data.trigger_config,
      disabled_at: null,
    };
    trigger.disabled_at = null;
    triggers.set(trigger.id, trigger);
    mutations++;
    return c.json({ trigger_id: trigger.id });
  });
  app.patch('/api/v3.1/trigger_instances/manage/:id', async (c) => {
    const input = z
      .object({ status: z.enum(['enable', 'disable']) })
      .strict()
      .safeParse(await jsonBody(c));
    const trigger = triggers.get(c.req.param('id'));
    if (!input.success || !trigger) return BAD_REQUEST(c);
    trigger.disabled_at = input.data.status === 'disable' ? new Date().toISOString() : null;
    mutations++;
    return c.json({ status: 'success' });
  });
  app.delete('/api/v3.1/trigger_instances/manage/:id', (c) => {
    if (!triggers.delete(c.req.param('id'))) return c.text('Not Found', 404);
    mutations++;
    return c.json({ status: 'success' });
  });
  app.notFound((c) => c.json({ error: 'Unknown offline route' }, 404));
  const server = createServer(getRequestListener(app.fetch, { overrideGlobalObjects: false }));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing offline listener address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  } catch (error) {
    server.closeAllConnections();
    server.close();
    throw error;
  }
  // The test-control group (`/api/test/composio`) that drives the fake.
  const routes = new Hono<ApiEnv>();
  routes.get('/status', (c) =>
    c.json({
      mode,
      accounts: accounts.size,
      accountOrdinals: [...accounts.values()].map((account) => account.ordinal),
      triggers: triggers.size,
      upstreamRequests,
      mutations,
    })
  );
  routes.post('/events-state', (c) => {
    const input = z
      .object({ mode: z.enum(['ready', 'unavailable']) })
      .strict()
      .safeParse(readJsonBody(c));
    if (!input.success) return c.text('Bad Request', 400);
    mode = input.data.mode;
    return c.json({ mode });
  });
  routes.post('/emit', async (c) => {
    const input = emitInput.safeParse(readJsonBody(c));
    if (!input.success) return c.text('Bad Request', 400);
    const account = [...accounts.values()].find(
      (item) => item.ordinal === input.data.accountOrdinal && item.status === 'ACTIVE'
    );
    const matches = [...triggers.values()].filter(
      (item) =>
        item.connected_account_id === account?.id &&
        item.trigger_name === input.data.eventType &&
        item.disabled_at === null
    );
    if (!account || matches.length !== 1)
      return c.json({ error: 'One active offline trigger is required' }, 409);
    const trigger = matches[0]!;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      type: input.data.eventType.toLowerCase(),
      timestamp: new Date().toISOString(),
      log_id: input.data.eventId,
      data: {
        connection_id: account.uuid,
        connection_nano_id: account.id,
        trigger_id: trigger.uuid,
        trigger_nano_id: trigger.id,
        user_id: COMPOSIO_FIXTURE_USER,
        subject: `Offline event ${input.data.eventId}`,
      },
    });
    const signature = createHmac(
      'sha256',
      input.data.signature === 'valid'
        ? COMPOSIO_FIXTURE_WEBHOOK_SECRET
        : 'invalid-fixture-signature'
    )
      .update(`${input.data.eventId}.${timestamp}.${body}`)
      .digest('base64');
    try {
      // Only outbound edge: fixed server loopback ingress. Redirects cannot escape it.
      const response = await fetch(ingressUrl, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
        headers: {
          'content-type': 'application/json',
          'webhook-id': input.data.eventId,
          'webhook-timestamp': timestamp,
          'webhook-signature': `v1,${signature}`,
        },
        body,
      });
      await response.body?.cancel();
      return c.json({ eventId: input.data.eventId, status: response.status });
    } catch {
      return c.json({ error: 'Offline ingress unavailable' }, 502);
    }
  });
  return {
    baseUrl,
    routes,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
