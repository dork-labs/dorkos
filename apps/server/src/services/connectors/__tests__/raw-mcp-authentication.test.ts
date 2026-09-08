import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectorAuthenticationFlows,
  connectorProviderInstances,
  eq,
  connections,
  createDb,
  runMigrations,
  type Db,
} from '@dorkos/db';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { ConnectorProviderInstanceIdSchema } from '@dorkos/shared/connector-schemas';
import { ConnectorProviderBootstrapper } from '../bootstrap.js';
import { ConnectorLifecycleService } from '../resources/lifecycle-service.js';
import { runProbe } from '../../mesh/agent-mcp-probe.js';
import { RawMcpConnectorProvider, type RawMcpConnectorProviderOpts } from '../providers/raw-mcp.js';
import { createRawMcpPendingConnectResolver } from '../resources/raw-mcp-pending-connect.js';
import { ConnectorRegistry } from '../registry.js';
import { ConnectorAuthenticationFlowService } from '../resources/authentication-flow-service.js';

const OWNER = { kind: 'local_install', installationId: 'raw-owner' } as const;
const INSTANCE = ConnectorProviderInstanceIdSchema.parse('raw-instance');
const NOW = new Date('2026-09-08T00:00:00.000Z');
const methods: string[] = [];
let holdTools: (() => Promise<void>) | undefined;
let malformedTools = false;
const app = express();
app.use(express.json());
app.post('/mcp', async (req, res) => {
  if (req.get('authorization') !== 'Bearer local-fixture-only') {
    res.status(401).set('WWW-Authenticate', 'Bearer').end();
    return;
  }
  if (req.body.method) methods.push(req.body.method as string);
  if (req.body.method === 'tools/list') {
    await holdTools?.();
    if (malformedTools) {
      res.json({ jsonrpc: '2.0', id: req.body.id, result: { tools: [{ broken: true }] } });
      return;
    }
  }
  const server = new McpServer({ name: 'durable-auth-fixture', version: '1.0.0' });
  server.registerTool('verified', { description: 'Authentication probe fixture.' }, () => ({
    content: [{ type: 'text', text: 'unused' }],
  }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  res.on('close', () => {
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  });
  await transport.handleRequest(req, res, req.body);
});
const target = swappableServer();
target.mount(app);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('raw MCP durable authentication', () => {
  let dir: string;
  let db: Db;
  beforeEach(() => {
    methods.length = 0;
    holdTools = undefined;
    malformedTools = false;
    dir = mkdtempSync(join(tmpdir(), 'dorkos-raw-auth-'));
    db = createDb(join(dir, 'db.sqlite'));
    runMigrations(db);
  });
  afterEach(() => {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function boot(options: { probe?: RawMcpConnectorProviderOpts['probe']; digest?: string } = {}) {
    const registry = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
    });
    const provider = new RawMcpConnectorProvider({
      instanceId: INSTANCE,
      ...(options.probe && { probe: options.probe }),
      resolvePendingConnect: createRawMcpPendingConnectResolver({
        db,
        registry,
        owner: OWNER,
        now: () => NOW,
      }),
      servers: ['notes', 'other'].map((slug) => ({
        slug,
        displayName: slug,
        connection: {
          transport: 'http',
          url: `http://localhost:${(target.server.address() as AddressInfo).port}/mcp`,
          headers: { Authorization: 'Bearer local-fixture-only' },
        },
      })),
    });
    registry.register(provider, options.digest ?? 'fixed-config');
    const service = new ConnectorAuthenticationFlowService({ db, registry, now: () => NOW });
    const lifecycle = new ConnectorLifecycleService({
      db,
      registry,
      authenticationFlows: service,
      authorityCleanup: {
        revokeConnection: vi.fn(),
        revokeAgent: vi.fn(),
        revokeAgentConnection: vi.fn(),
      },
    });
    return { registry, provider, service, lifecycle };
  }

  it('reconstructs the original pending flow from disk and proves initialize/tools/list', async () => {
    const first = boot();
    const started = await first.service.start(OWNER, {
      providerInstanceId: INSTANCE,
      toolkit: 'notes',
      label: 'My notes',
      idempotencyKey: 'original',
    });
    expect(started.state).toBe('pending');
    expect(methods).toEqual([]);
    db.$client.close();
    db = createDb(join(dir, 'db.sqlite'));
    const restarted = boot();
    const completed = await restarted.service.poll(OWNER, started.flowId);
    expect(completed.state).toBe('connected');
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    const rows = db.select().from(connections).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: 'My notes', externalAccountRef: 'mcp:notes' });
    expect(completed).toMatchObject({ connectionId: rows[0]!.id });
    expect(await boot().service.poll(OWNER, started.flowId)).toEqual(completed);
    expect(methods).toHaveLength(3);
  });
  function privateRow(flowId: string) {
    return db
      .select()
      .from(connectorAuthenticationFlows)
      .where(eq(connectorAuthenticationFlows.id, flowId))
      .get()!;
  }

  async function start(
    context: ReturnType<typeof boot>,
    idempotencyKey = 'pending',
    toolkit = 'notes'
  ) {
    return context.service.start(OWNER, {
      providerInstanceId: INSTANCE,
      toolkit,
      label: 'Original label',
      idempotencyKey,
    });
  }

  it('uses the actual bootstrap construction port to resume a pending protocol check', async () => {
    async function productionBoot() {
      const registry = new ConnectorRegistry({
        db,
        configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
      });
      const bootstrap = new ConnectorProviderBootstrapper({
        registry,
        credentials: {
          resolve: async (ref) => ({
            ok: false,
            reason: 'unresolved',
            ref,
            message: 'fixture has no vendor keys',
          }),
        },
        nangoEnv: () => ({}),
        rawMcpServers: () => [
          {
            slug: 'notes',
            displayName: 'Notes',
            connection: {
              transport: 'http',
              url: `http://localhost:${(target.server.address() as AddressInfo).port}/mcp`,
              headers: { Authorization: 'Bearer local-fixture-only' },
            },
          },
        ],
        rawMcpPendingConnect: createRawMcpPendingConnectResolver({
          db,
          registry,
          owner: OWNER,
          now: () => NOW,
        }),
      });
      await bootstrap.registerBootProviders();
      return {
        registry,
        service: new ConnectorAuthenticationFlowService({ db, registry, now: () => NOW }),
      };
    }
    const first = await productionBoot();
    const provider = first.registry.resolveProvider('mcp')!;
    const pending = await first.service.start(OWNER, {
      providerInstanceId: provider.instanceId,
      toolkit: 'notes',
      label: 'Bootstrap',
      idempotencyKey: 'bootstrap',
    });
    db.$client.close();
    db = createDb(join(dir, 'db.sqlite'));
    const restored = await productionBoot();
    expect(await restored.service.poll(OWNER, pending.flowId)).toMatchObject({
      state: 'connected',
    });
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    expect(db.select().from(connections).all()).toMatchObject([{ label: 'Bootstrap' }]);
  });

  it('does not resolve a handle through another configured raw instance', async () => {
    const context = boot();
    const flow = await start(context);
    const other = new RawMcpConnectorProvider({
      instanceId: ConnectorProviderInstanceIdSchema.parse('other-instance'),
      servers: [
        {
          slug: 'notes',
          displayName: 'Notes',
          connection: {
            transport: 'http',
            url: `http://localhost:${(target.server.address() as AddressInfo).port}/mcp`,
          },
        },
      ],
      resolvePendingConnect: createRawMcpPendingConnectResolver({
        db,
        registry: context.registry,
        owner: OWNER,
        now: () => NOW,
      }),
    });
    context.registry.register(other, 'other-material');
    expect(await other.pollConnect(privateRow(flow.flowId).providerFlowId!)).toMatchObject({
      status: 'failed',
    });
    expect(methods).toEqual([]);
    expect(await other.listAccounts()).toEqual([]);
  });

  it('gives fresh starts unique handles after restart and preserves the original toolkit', async () => {
    const original = await start(boot(), 'old');
    const restarted = boot();
    const newer = await start(restarted, 'new', 'other');
    expect(privateRow(original.flowId).providerFlowId).not.toBe(
      privateRow(newer.flowId).providerFlowId
    );
    expect(await restarted.service.poll(OWNER, original.flowId)).toMatchObject({
      state: 'connected',
      toolkit: 'notes',
    });
    expect(db.select().from(connections).all()).toMatchObject([
      { toolkit: 'notes', label: 'Original label' },
    ]);
  });

  it.each([
    'expired',
    'invalid-expiry',
    'terminal',
    'wrong-owner',
    'unavailable',
    'wrong-instance-owner',
    'changed-generation',
    'unknown-toolkit',
    'changed-toolkit',
    'changed-label',
    'wrong-hash',
    'ambiguous',
  ])('refuses %s durable selectors before any protocol request', async (reason) => {
    const original = await start(boot());
    const row = privateRow(original.flowId);
    const restarted = boot();
    const flowPatch =
      reason === 'expired'
        ? { expiresAt: NOW.toISOString() }
        : reason === 'invalid-expiry'
          ? { expiresAt: 'not-a-date' }
          : reason === 'terminal'
            ? { state: 'failed' as const }
            : reason === 'wrong-owner'
              ? { ownerId: 'other-owner' }
              : reason === 'changed-generation'
                ? { executionConfigGeneration: row.executionConfigGeneration + 1 }
                : reason === 'unknown-toolkit'
                  ? { toolkit: 'not-configured' }
                  : reason === 'changed-toolkit'
                    ? { toolkit: 'other' }
                    : reason === 'changed-label'
                      ? { label: 'Replacement' }
                      : reason === 'wrong-hash'
                        ? { requestHash: 'wrong' }
                        : undefined;
    if (flowPatch)
      db.update(connectorAuthenticationFlows)
        .set(flowPatch)
        .where(eq(connectorAuthenticationFlows.id, row.id))
        .run();
    if (reason === 'unavailable')
      db.update(connectorProviderInstances)
        .set({ status: 'unavailable' })
        .where(eq(connectorProviderInstances.id, INSTANCE))
        .run();
    if (reason === 'wrong-instance-owner')
      db.update(connectorProviderInstances)
        .set({ ownerId: 'other-owner' })
        .where(eq(connectorProviderInstances.id, INSTANCE))
        .run();
    if (reason === 'ambiguous')
      db.insert(connectorAuthenticationFlows)
        .values({ ...row, id: 'duplicate', idempotencyKey: 'duplicate' })
        .run();
    expect(await restarted.provider.pollConnect(row.providerFlowId!)).toMatchObject({
      status: 'failed',
    });
    expect(methods).toEqual([]);
    expect(await restarted.provider.listAccounts()).toEqual([]);
    expect(db.select().from(connections).all()).toEqual([]);
  });

  it('refuses malformed and unknown handles and a stale provider object', async () => {
    const old = boot();
    const flow = await start(old);
    const handle = privateRow(flow.flowId).providerFlowId!;
    const current = new RawMcpConnectorProvider({
      instanceId: INSTANCE,
      servers: [],
      resolvePendingConnect: createRawMcpPendingConnectResolver({
        db,
        registry: old.registry,
        owner: OWNER,
        now: () => NOW,
      }),
    });
    old.registry.register(current, 'fixed-config');
    for (const selector of [
      handle,
      'mcp-flow-1',
      'raw-mcp:v1:not-a-uuid',
      'raw-mcp:v1:00000000-0000-4000-8000-000000000000',
    ]) {
      expect(await old.provider.pollConnect(selector)).toMatchObject({ status: 'failed' });
    }
    expect(methods).toEqual([]);
    expect(await old.provider.listAccounts()).toEqual([]);
  });

  it('rejects foreign-owner polling and a changed material generation after disk reopen', async () => {
    const first = boot();
    const flow = await start(first);
    await expect(
      first.service.poll({ kind: 'local_install', installationId: 'foreign' }, flow.flowId)
    ).rejects.toMatchObject({ code: 'flow_not_found' });
    db.$client.close();
    db = createDb(join(dir, 'db.sqlite'));
    const changed = boot({ digest: 'replacement-material' });
    expect(await changed.service.poll(OWNER, flow.flowId)).toMatchObject({ state: 'failed' });
    expect(methods).toEqual([]);
    expect(db.select().from(connections).all()).toEqual([]);
  });

  it('reconnects an already-connected raw account with the same stable ID and original label', async () => {
    const context = boot();
    const flow = await start(context);
    const connected = await context.service.poll(OWNER, flow.flowId);
    expect(connected.state).toBe('connected');
    if (connected.state !== 'connected') throw new Error('expected connection');
    const reconnect = await context.service.reconnect(OWNER, connected.connectionId, 'reconnect');
    expect(reconnect.state).toBe('pending');
    expect(await context.service.poll(OWNER, reconnect.flowId)).toMatchObject({
      state: 'connected',
      connectionId: connected.connectionId,
    });
    expect(db.select().from(connections).all()).toMatchObject([
      { id: connected.connectionId, label: 'Original label', enabled: true },
    ]);
    expect(await context.provider.listAccounts()).toHaveLength(1);
    expect(methods).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'initialize',
      'notifications/initialized',
      'tools/list',
    ]);
  });

  it('durably cancels initial raw checks and reconnects only for the disconnected toolkit', async () => {
    const context = boot();
    const first = await start(context, 'first');
    const initial = await start(context, 'initial');
    const other = await start(context, 'other', 'other');
    const connected = await context.service.poll(OWNER, first.flowId);
    if (connected.state !== 'connected') throw new Error('expected connection');
    const reconnect = await context.service.reconnect(OWNER, connected.connectionId, 'reconnect');
    await context.lifecycle.disconnect(OWNER, connected.connectionId, AbortSignal.timeout(1000));
    const restarted = boot();
    expect(await restarted.service.poll(OWNER, initial.flowId)).toMatchObject({ state: 'failed' });
    expect(await restarted.service.poll(OWNER, reconnect.flowId)).toMatchObject({
      state: 'failed',
    });
    expect(methods).toHaveLength(3);
    expect(db.select().from(connections).all()).toMatchObject([{ lifecycleState: 'disconnected' }]);
    expect(await restarted.service.poll(OWNER, other.flowId)).toMatchObject({
      state: 'connected',
      toolkit: 'other',
    });
    expect(methods).toHaveLength(6);
  });

  it.each(['disconnect', 'expiry', 'owner', 'generation', 'label'])(
    'rejects %s during actual tools/list without persisting stale success',
    async (change) => {
      const context = boot();
      const established = await start(context, 'established');
      const account = await context.service.poll(OWNER, established.flowId);
      if (account.state !== 'connected') throw new Error('expected connection');
      const pending = await start(context, 'pending');
      const entered = deferred();
      const release = deferred();
      holdTools = () => {
        entered.resolve();
        return release.promise;
      };
      const polling = context.service.poll(OWNER, pending.flowId);
      await entered.promise;
      if (change === 'disconnect')
        await context.lifecycle.disconnect(OWNER, account.connectionId, AbortSignal.timeout(1000));
      else if (change === 'owner')
        db.update(connectorProviderInstances)
          .set({ ownerId: 'foreign' })
          .where(eq(connectorProviderInstances.id, INSTANCE))
          .run();
      else if (change === 'generation')
        context.registry.register(context.provider, 'changed-config');
      else
        db.update(connectorAuthenticationFlows)
          .set(change === 'expiry' ? { expiresAt: NOW.toISOString() } : { label: 'Changed label' })
          .where(eq(connectorAuthenticationFlows.id, pending.flowId))
          .run();
      release.resolve();
      expect(await polling).toMatchObject({ state: change === 'expiry' ? 'expired' : 'failed' });
      expect(methods).toHaveLength(6);
      const rows = db.select().from(connections).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ label: 'Original label' });
      if (change === 'disconnect') {
        expect(rows[0]?.lifecycleState).toBe('disconnected');
        expect(await context.provider.listAccounts()).toEqual([]);
      }
    }
  );

  it('rejects malformed tools/list responses after reconstruction', async () => {
    const flow = await start(boot());
    malformedTools = true;
    expect(await boot().service.poll(OWNER, flow.flowId)).toMatchObject({ state: 'failed' });
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    expect(db.select().from(connections).all()).toEqual([]);
  });

  it('bounds a real unresponsive tools/list and records no account', async () => {
    const release = deferred();
    holdTools = () => release.promise;
    const context = boot({
      probe: (connection) =>
        // Allow the real HTTP handshake under parallel suite load before timing out tools/list.
        runProbe({ ...connection, headers: connection.headers ?? {} }, undefined, 2_000),
    });
    const flow = await start(context);
    try {
      expect(await context.service.poll(OWNER, flow.flowId)).toMatchObject({ state: 'failed' });
      expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
      expect(db.select().from(connections).all()).toEqual([]);
    } finally {
      release.resolve();
    }
  });
});
