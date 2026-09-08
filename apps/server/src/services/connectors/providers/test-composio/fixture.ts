/** Offline upstream for real Composio clients. Loaded only by the test-runtime bootstrap. */
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import express, { Router } from 'express';
import { z } from 'zod';
import { stableStringify } from '@dorkos/shared/capabilities';
import { legacyDefaultProviderInstanceId } from '../../legacy-connection-migration.js';
import {
  COMPOSIO_FIXTURE_KEY,
  COMPOSIO_FIXTURE_USER,
  COMPOSIO_FIXTURE_VERSION,
  COMPOSIO_FIXTURE_WEBHOOK_SECRET,
  COMPOSIO_FIXTURE_EVENTS,
  fixtureDefinitions,
  fixtureOperation,
} from './data.js';

const accountInput = z
  .object({
    auth_config: z.object({ id: z.literal('ac_offline_gmail') }).strict(),
    connection: z
      .object({ user_id: z.literal(COMPOSIO_FIXTURE_USER), alias: z.string().max(200).optional() })
      .strict(),
  })
  .strict();
const triggerInput = z
  .object({
    connected_account_id: z.string(),
    user_id: z.literal(COMPOSIO_FIXTURE_USER),
    toolkit_versions: z.object({ gmail: z.literal(COMPOSIO_FIXTURE_VERSION) }).strict(),
    trigger_config: z
      .record(z.string().min(1).max(200), z.string().max(200))
      .refine((filter) => Object.keys(filter).length <= 20),
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
  trigger_config: Record<string, string>;
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
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.get('/consent/:id', (req, res) => {
    if (!accounts.has(req.params.id)) return void res.sendStatus(404);
    res
      .type('html')
      .send(
        '<!doctype html><html lang="en"><title>Offline Gmail consent</title><body><h1>Connect test Gmail</h1><form method="post"><button type="submit">Allow test Gmail</button></form></body></html>'
      );
  });
  app.post('/consent/:id', (req, res) => {
    const account = accounts.get(req.params.id);
    if (!account) return void res.sendStatus(404);
    account.status = 'ACTIVE';
    res
      .type('html')
      .send(
        '<!doctype html><html lang="en"><title>Connected</title><body><p>Test Gmail connected. You may close this window.</p></body></html>'
      );
  });
  app.use((req, res, next) => {
    upstreamRequests++;
    if (req.headers['x-api-key'] !== COMPOSIO_FIXTURE_KEY)
      return void res
        .status(401)
        .json({ error: { message: 'Offline project key required', status: 401 } });
    next();
  });
  const page = (items: unknown[]) => ({ items, current_page: 1, total_pages: 1 });
  const versionMatches = (query: Record<string, unknown>) =>
    query['toolkit_versions[gmail]'] === COMPOSIO_FIXTURE_VERSION;
  const listMatches = (query: Record<string, unknown>, key: string, value: string) =>
    query[key] === value || query[`${key}[]`] === value;
  const toolkit = {
    slug: 'gmail',
    name: 'Gmail',
    auth_schemes: ['OAUTH2'],
    no_auth: false,
    meta: { version: COMPOSIO_FIXTURE_VERSION },
  };
  app.get('/api/v3.1/toolkits', (_req, res) => res.json(page([toolkit])));
  app.get('/api/v3.1/toolkits/gmail', (_req, res) => res.json(toolkit));
  app.get('/api/v3.1/auth_configs', (req, res) => {
    if (req.query.toolkit_slug !== 'gmail') return void res.sendStatus(400);
    res.json(page([{ id: 'ac_offline_gmail', is_disabled: false }]));
  });
  app.post('/api/v3.1/connected_accounts', (req, res) => {
    const input = accountInput.safeParse(req.body);
    if (!input.success || accounts.size >= 100) return void res.sendStatus(400);
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
    res.json({ id, status: account.status, redirect_url: `${baseUrl}/consent/${id}` });
  });
  app.get('/api/v3.1/connected_accounts', (req, res) => {
    if (
      !listMatches(req.query, 'user_ids', COMPOSIO_FIXTURE_USER) ||
      (req.query.toolkit_slugs && req.query.toolkit_slugs !== 'gmail')
    )
      return void res.sendStatus(400);
    res.json(page([...accounts.values()]));
  });
  app.get('/api/v3.1/connected_accounts/:id', (req, res) => {
    const account = accounts.get(req.params.id);
    if (!account) return void res.sendStatus(404);
    res.json(account);
  });
  app.delete('/api/v3.1/connected_accounts/:id', (req, res) => {
    if (!accounts.delete(req.params.id)) return void res.sendStatus(404);
    mutations++;
    res.json({ success: true });
  });
  app.get('/api/v3.1/tools', (req, res) => {
    if (req.query.toolkit_slug !== 'gmail' || !versionMatches(req.query))
      return void res.sendStatus(400);
    res.json(page([fixtureOperation()]));
  });
  app.get('/api/v3.1/tools/GMAIL_FETCH_EMAILS', (req, res) => {
    if (req.query.version !== COMPOSIO_FIXTURE_VERSION) return void res.sendStatus(400);
    res.json(fixtureOperation());
  });
  app.post('/api/v3.1/tools/execute/GMAIL_FETCH_EMAILS', (req, res) => {
    const input = z
      .object({
        connected_account_id: z.string(),
        user_id: z.literal(COMPOSIO_FIXTURE_USER),
        version: z.literal(COMPOSIO_FIXTURE_VERSION),
        arguments: z.object({}).strict(),
        allow_tracing: z.literal(false),
      })
      .strict()
      .safeParse(req.body);
    const account = input.success && accounts.get(input.data.connected_account_id);
    if (!input.success || !account || account.status !== 'ACTIVE') return void res.sendStatus(400);
    res.json({
      successful: true,
      error: null,
      data: { messages: [{ subject: `Offline Gmail account ${account.ordinal}` }] },
      log_id: 'offline_execution',
    });
  });
  app.get('/api/v3.1/triggers_types', (req, res) => {
    if (!listMatches(req.query, 'toolkit_slugs', 'gmail') || !versionMatches(req.query))
      return void res.sendStatus(400);
    res.json(page(fixtureDefinitions()));
  });
  app.get('/api/v3.1/triggers_types/:slug', (req, res) => {
    const definition = fixtureDefinitions().find((item) => item.slug === req.params.slug);
    if (!definition || !versionMatches(req.query)) return void res.sendStatus(400);
    res.json(definition);
  });
  app.get('/api/v3.1/trigger_instances/active', (req, res) => {
    if (mode === 'unavailable') return void res.sendStatus(503);
    const account = [...accounts.values()].find((item) =>
      listMatches(req.query, 'connected_account_ids', item.id)
    );
    const event = COMPOSIO_FIXTURE_EVENTS.find((item) =>
      listMatches(req.query, 'trigger_names', item)
    );
    if (
      !account ||
      account.status !== 'ACTIVE' ||
      !event ||
      !listMatches(req.query, 'user_ids', COMPOSIO_FIXTURE_USER) ||
      req.query.show_disabled !== 'true'
    )
      return void res.sendStatus(400);
    res.json(
      page(
        [...triggers.values()].filter(
          (item) => item.connected_account_id === account.id && item.trigger_name === event
        )
      )
    );
  });
  app.post('/api/v3.1/trigger_instances/:slug/upsert', (req, res) => {
    const input = triggerInput.safeParse(req.body);
    const account = input.success && accounts.get(input.data.connected_account_id);
    if (
      !input.success ||
      !account ||
      account.status !== 'ACTIVE' ||
      !COMPOSIO_FIXTURE_EVENTS.some((item) => item === req.params.slug) ||
      (req.params.slug !== 'GMAIL_UNSUPPORTED_FILTER' &&
        Object.keys(input.data.trigger_config).some((key) => key !== 'label'))
    )
      return void res.sendStatus(400);
    if (mode === 'unavailable') return void res.sendStatus(503);
    const existing = [...triggers.values()].find(
      (item) =>
        item.connected_account_id === account.id &&
        item.trigger_name === req.params.slug &&
        stableStringify(item.trigger_config) === stableStringify(input.data.trigger_config)
    );
    const trigger: Trigger = existing ?? {
      id: `tr_${randomUUID()}`,
      uuid: randomUUID(),
      connected_account_id: account.id,
      connected_account_uuid: account.uuid,
      user_id: COMPOSIO_FIXTURE_USER,
      trigger_name: req.params.slug,
      version: COMPOSIO_FIXTURE_VERSION,
      trigger_config: input.data.trigger_config,
      disabled_at: null,
    };
    trigger.disabled_at = null;
    triggers.set(trigger.id, trigger);
    mutations++;
    res.json({ trigger_id: trigger.id });
  });
  app.patch('/api/v3.1/trigger_instances/manage/:id', (req, res) => {
    const input = z
      .object({ status: z.enum(['enable', 'disable']) })
      .strict()
      .safeParse(req.body);
    const trigger = triggers.get(req.params.id);
    if (!input.success || !trigger) return void res.sendStatus(400);
    trigger.disabled_at = input.data.status === 'disable' ? new Date().toISOString() : null;
    mutations++;
    res.json({ status: 'success' });
  });
  app.delete('/api/v3.1/trigger_instances/manage/:id', (req, res) => {
    if (!triggers.delete(req.params.id)) return void res.sendStatus(404);
    mutations++;
    res.json({ status: 'success' });
  });
  app.use((_req, res) => {
    res.status(404).json({ error: 'Unknown offline route' });
  });
  const server = createServer(app);
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
  const router = Router();
  router.get('/status', (_req, res) =>
    res.json({
      mode,
      accounts: accounts.size,
      accountOrdinals: [...accounts.values()].map((account) => account.ordinal),
      triggers: triggers.size,
      upstreamRequests,
      mutations,
    })
  );
  router.post('/events-state', (req, res) => {
    const input = z
      .object({ mode: z.enum(['ready', 'unavailable']) })
      .strict()
      .safeParse(req.body);
    if (!input.success) return void res.sendStatus(400);
    mode = input.data.mode;
    res.json({ mode });
  });
  router.post('/emit', async (req, res) => {
    const input = emitInput.safeParse(req.body);
    if (!input.success) return void res.sendStatus(400);
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
      return void res.status(409).json({ error: 'One active offline trigger is required' });
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
      res.json({ eventId: input.data.eventId, status: response.status });
    } catch {
      res.status(502).json({ error: 'Offline ingress unavailable' });
    }
  });
  return {
    baseUrl,
    router,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
