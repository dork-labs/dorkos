/** Real service/MCP integration; the maintained fixture authority policy is not full app/browser acceptance. */
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  canvasDocBatches,
  sessionMessageQueue,
  sessionMessageAcceptanceReceipts,
  sessionMetadata,
  eq,
} from '@dorkos/db';
import { noopLogger } from '@dorkos/shared/logger';
import type { ServerPrincipalProof } from '../../../../connectors/principal/server-principal.js';
import { composeRegistry } from '../../../../core/capabilities/index.js';
import { setCanvasService, peekCanvasService } from '../../../../canvas/index.js';
import { uiDomain } from '../../../../session/browser-seat/ui-capabilities.js';
import { runtimeDocMcpFixture } from '../../../../canvas/doc-channel/__tests__/runtime-doc-mcp-fixture.js';
import { createAgentRuntimeMcpServer } from '../../../connector-mcp/agent-runtime-server.js';
import { startConnectorRuntimeMcpListener } from '../../../connector-mcp/listener.js';
import { createDocFrameSdkProbe, type DocFrameSdkReady } from '../doc-frame-sdk-probe.js';
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function fixture() {
  const f = await runtimeDocMcpFixture('claude-code', 'chat');
  cleanups.push(() => f.close());
  const prior = peekCanvasService();
  setCanvasService(f.canvas);
  if (prior) cleanups.push(async () => setCanvasService(prior));
  const registry = composeRegistry([uiDomain], {
    logger: noopLogger,
    docChannelGrantDeps: { service: f.http.grants, authorization: f.http.authorization },
    docChannelDownstream: f.http.downstream,
  });
  let principal: ServerPrincipalProof | undefined;
  const listener = await startConnectorRuntimeMcpListener({
    principals: f.principals,
    // The probe speaks as Claude Code, as it does under DORKOS_TEST_RUNTIME.
    acceptInProcessRuntime: true,
    serverFactory: () => new McpServer({ name: 'unused-connectors', version: '1.0.0' }),
    agentServerFactory: (actual) => {
      principal = actual;
      return createAgentRuntimeMcpServer(registry, actual, f.identity);
    },
  });
  cleanups.push(() => listener.close());
  const opened = vi.spyOn(f.principals, 'openTurn');
  const run = createDocFrameSdkProbe({
    enabled: true,
    tools: {
      principals: f.principals,
      listenerUrl: listener.url,
      agentToolsUrl: listener.agentUrl,
      isConnectorCapabilityId: () => false,
    },
    channels: f.http.channels,
    bindProbeSession: async (sessionId, agentPath) => {
      // The maintained fixture already persisted this actual managed session. No alternate policy.
      const row = f.db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, sessionId))
        .get();
      expect(row).toMatchObject({ runtime: 'claude-code', agentPath });
    },
  });
  const sourcePath = join(f.dir, 'sdk-fixture.html');
  await fs.writeFile(sourcePath, '<!doctype html><html><head></head><body>Fixture</body></html>', {
    flag: 'wx',
    mode: 0o600,
  });
  return { ...f, run, sourcePath, opened, principal: () => principal };
}
it('opens through the original UI tool and grants exact log-only routing through one real authenticated MCP turn', async () => {
  const f = await fixture(),
    ready = deferred<DocFrameSdkReady>(),
    finish = deferred<void>();
  const work = f.run({
    sessionId: 'session-1',
    agentPath: f.dir,
    sourcePath: f.sourcePath,
    signal: new AbortController().signal,
    onReady: ready.resolve,
    waitForBrowser: () => finish.promise,
  });
  // Attach a rejection handler before awaiting readiness, so setup failures report instead of hanging.
  const value = await Promise.race([
    ready.promise,
    work.then<never>(() => {
      throw new Error('No readiness');
    }),
  ]);
  try {
    const row = f.http.channels.getChannel(value.documentId)!;
    expect(row.openerAgentId).toBe('agent-1');
    const routes = f.http.grants.getCurrentRoutes(value.documentId, 'fixture.changed', {
      surface: 'capability',
      principal: f.principal()!,
    });
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      route: { on: 'fixture.changed', to: 'log', turn: { mode: 'none' } },
      allowedTypes: ['fixture.changed'],
    });
    const grant = f.http.channels.getGrant(routes[0].grantId!)!;
    expect(grant.approvalEvidence).toMatchObject({ kind: 'verified_opener' });
    expect(grant.approvalId).toBeNull();
    expect(f.opened).toHaveBeenCalledTimes(1);
    const binding = await f.opened.mock.results[0].value;
    expect(
      (
        await f.principals.resolve({
          bearer: binding.bearer,
          expectedRuntime: 'claude-code',
          expectedCanonicalCwd: f.dir,
        })
      ).status
    ).toBe('resolved');
  } finally {
    finish.resolve();
    await work;
  }
  const binding = await f.opened.mock.results[0].value;
  expect(
    (
      await f.principals.resolve({
        bearer: binding.bearer,
        expectedRuntime: 'claude-code',
        expectedCanonicalCwd: f.dir,
      })
    ).status
  ).toBe('refused');
});
it('records a genuine upstream service receipt without a batch, shared queue admission or agent turn', async () => {
  const f = await fixture(),
    ready = deferred<DocFrameSdkReady>(),
    finish = deferred<void>();
  const before = {
    batches: f.db.select().from(canvasDocBatches).all(),
    queue: f.db.select().from(sessionMessageQueue).all(),
    receipts: f.db.select().from(sessionMessageAcceptanceReceipts).all(),
  };
  const work = f.run({
    sessionId: 'session-1',
    agentPath: f.dir,
    sourcePath: f.sourcePath,
    signal: new AbortController().signal,
    onReady: ready.resolve,
    waitForBrowser: () => finish.promise,
  });
  const value = await Promise.race([
    ready.promise,
    work.then<never>(() => {
      throw new Error('No readiness');
    }),
  ]);
  try {
    const id = crypto.randomUUID(),
      payload = { text: 'Actual integration input' };
    // Original service + exact listener-issued proof. This is not a browser/HTTP assertion.
    const receipt = await f.http.service.ingestEvent(
      value.documentId,
      { v: 1, id, type: 'fixture.changed', payload },
      { surface: 'capability', principal: f.principal()! }
    );
    expect(receipt.receipt).toMatchObject({ id, status: 'recorded' });
    expect(receipt.deliveries).toHaveLength(1);
    expect(receipt.deliveries[0]).toMatchObject({
      status: 'routed',
      reason: 'no_turn',
      batchId: null,
      turnId: null,
    });
    expect(f.http.channels.getEvent(value.documentId, id)?.payload).toEqual(payload);
    expect(f.db.select().from(canvasDocBatches).all()).toEqual(before.batches);
    expect(f.db.select().from(sessionMessageQueue).all()).toEqual(before.queue);
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual(before.receipts);
  } finally {
    finish.resolve();
    await work;
  }
});
