import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Doe,
  SqliteModelStore,
  DeferredToolRegistry,
  createToolSearch,
  McpConnection,
  LocalResources,
  createBuilderTool,
  createCompaction,
  createBeatExtension,
  INITIAL_SCHEMA_BUDGET_BYTES,
  type DoeConfig,
  type DoeEvent,
} from '../index.js';
import { deliveryFixture } from './delivery-fixture.js';

it('delivers deferred MCP, builder, durable restart, compaction and isolated beat through real offline Pi requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doe-delivery-'));
  const wire = await deliveryFixture();
  const logSpies = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
  ];
  let store: SqliteModelStore | undefined;
  let mcp: McpConnection | undefined;
  try {
    const registry = new DeferredToolRegistry();
    registry.register(createToolSearch(registry));
    const schemaBytes = () =>
      Buffer.byteLength(
        JSON.stringify(
          registry
            .selected()
            .map(({ name, description, schema }) => ({ name, description, schema }))
        )
      );
    const beforeMcp = schemaBytes();
    for (let i = 0; i < 1000; i++)
      registry.register({
        name: `archival_${i}`,
        description: 'archival maintenance',
        schema: { type: 'object', description: 'x'.repeat(4096) },
        execute: async () => {
          throw new Error('Unselected inventory tool executed');
        },
      });
    expect(schemaBytes()).toBe(beforeMcp);
    mcp = new McpConnection(
      'delivery',
      {
        kind: 'http',
        url: wire.mcpEndpoint,
        headers: { authorization: 'Bearer mcp-delivery-secret' },
      },
      { callTimeoutMs: 5000 }
    );
    await mcp.connect();
    const [alias] = await mcp.registerTools(registry);
    expect(alias).toBeTruthy();
    expect(schemaBytes()).toBe(beforeMcp);
    expect(wire.credentialReceived()).toBe(true);
    const metadata = registry.inventory({ offset: 1001, limit: 1 }).items;
    expect(metadata).toHaveLength(1);
    expect(metadata[0].name).toBe(alias);
    expect(JSON.stringify(metadata)).not.toContain('mcp-delivery-secret');
    expect(JSON.stringify(registry.selected())).not.toContain('mcp-delivery-secret');
    expect(schemaBytes()).toBeLessThan(INITIAL_SCHEMA_BUDGET_BYTES);
    expect(registry.selected().some((tool) => tool.name === alias)).toBe(false);
    const policy = { readRoots: [root], writeRoots: [root] };
    const resources = () =>
      new LocalResources(
        { ancestorDirectories: [root], skillRoots: [], context: 'CURRENT BUSINESS GUIDANCE' },
        policy,
        root
      );
    registry.register(
      createBuilderTool({
        workingDirectory: root,
        pathPolicy: policy,
        resources: resources(),
        guidance: 'Write the requested artifact.',
        maxResultCharacters: 2000,
        maxDurationMs: 10000,
        maxOutputBytes: 16384,
        executionPolicy: { kind: 'unrestricted', environment: {} },
      })
    );
    expect(schemaBytes()).toBeLessThan(INITIAL_SCHEMA_BUDGET_BYTES);
    wire.stages.push(
      { tool: 'tool_search', args: { query: 'invoice', limit: 1 } },
      { tool: alias, args: {} },
      { tool: 'builder', args: { task: 'Write delivery.txt with verified content' } },
      { tool: 'write', args: { path: 'delivery.txt', content: 'verified' } },
      { text: 'Wrote and verified delivery.txt.' },
      { text: 'Invoice checked and artifact written.' },
      { text: 'Outcome: invoice paid. Artifact: delivery.txt. No open commitments.' },
      { text: 'Continued from compacted context.' },
      { tool: 'end_beat', args: { kind: 'quiet' } }
    );
    const file = join(root, 'history.db');
    store = new SqliteModelStore(file);
    store.createSession('delivery');
    for (let turn = 0; turn < 2; turn++) {
      store.appendMessage('delivery', { role: 'user', content: `prior business turn ${turn}` });
      store.appendMessage('delivery', {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'prior opaque thinking', signature: 'signed' },
          { type: 'text', text: `prior decision ${turn}` },
        ],
        opaque: { signature: 'historical-signature' },
      });
    }
    const events: DoeEvent[] = [];
    const approvals: Array<{ name: string; scope: string }> = [];
    const config: DoeConfig = {
      sessionId: 'delivery',
      workingDirectory: root,
      store,
      registry,
      resources: resources(),
      pathPolicy: policy,
      model: {
        protocol: 'openai-completions',
        endpoint: wire.modelEndpoint,
        id: 'local',
        payer: 'host',
        historyFamily: 'local',
        contextWindow: 100000,
        maxOutputTokens: 1000,
        supportsThinking: true,
        credentials: async () => 'fixture-delivery-secret',
      },
      approve: async (tool, _args, context) => {
        approvals.push({ name: tool.name, scope: context.scope });
        return 'allow';
      },
      onEvent: (event) => events.push(event),
      extensions: {
        ...createCompaction({ reserveTokens: 2000, retainTurns: 1 }),
        runBeat: createBeatExtension(),
      },
    };
    const result = await new Doe(config).run('Check invoice and write artifact');
    expect(result.stopReason).toBe('stop');
    expect(result.approvalDenied).not.toBe(true);
    expect(await readFile(join(root, 'delivery.txt'), 'utf8')).toBe('verified');
    expect(wire.bodies).toHaveLength(6);
    expect(JSON.stringify(wire.bodies[0].tools)).not.toContain(alias);
    expect(JSON.stringify(wire.bodies[1].tools)).toContain(alias);
    expect(JSON.stringify(wire.bodies[1].messages)).toContain(
      '"reasoning_content":"opaque signed history"'
    );
    expect(approvals).toContainEqual({ name: alias, scope: 'main' });
    expect(approvals.some((item) => item.name === 'write' && item.scope.startsWith('child:'))).toBe(
      true
    );
    expect(events.some((event) => event.type === 'text' && event.scope.startsWith('child:'))).toBe(
      true
    );
    const originalArchive = store.archive('delivery');
    expect(JSON.stringify(originalArchive)).toContain('opaque signed history');
    expect(
      store.allUsage('delivery').filter((item) => item.scope.startsWith('child:'))
    ).toHaveLength(2);
    store.close();
    store = new SqliteModelStore(file);
    config.store = store;
    expect(store.archive('delivery')).toEqual(originalArchive);
    await new Doe(config).compact();
    expect(wire.bodies).toHaveLength(7);
    expect(JSON.stringify(wire.bodies[6])).toContain('prior business turn');
    expect(JSON.stringify(wire.bodies[6])).toContain('prior opaque thinking');
    expect(store.archive('delivery')).toEqual(originalArchive);
    const checkpoint = store.restore('delivery').checkpoint;
    expect(checkpoint).toBeDefined();
    expect(JSON.stringify(checkpoint?.currentSystem)).toContain('CURRENT BUSINESS GUIDANCE');
    store.close();
    store = new SqliteModelStore(file);
    config.store = store;
    expect(store.restore('delivery').checkpoint).toEqual(checkpoint);
    const continuation = await new Doe(config).run('Continue after reopen');
    expect(continuation.stopReason).toBe('stop');
    expect(JSON.stringify(wire.bodies[7])).toContain('Business context summary');
    expect(JSON.stringify(wire.bodies[7])).toContain('CURRENT BUSINESS GUIDANCE');
    const mainContext = store.restore('delivery'),
      mainArchive = store.archive('delivery');
    expect(
      await new Doe(config).runBeat({
        id: 'delivery',
        prompt: 'Check commitments',
        commitments: 'Invoice already reported as paid',
      })
    ).toEqual({ kind: 'quiet' });
    expect(wire.bodies).toHaveLength(9);
    expect(store.restore('delivery')).toEqual(mainContext);
    expect(store.archive('delivery')).toEqual(mainArchive);
    expect(store.outcomes('delivery', 'beat:delivery')).toHaveLength(1);
    const usage = store.allUsage('delivery');
    expect(usage).toHaveLength(9);
    expect(new Set(usage.map((item) => item.usage.requestId)).size).toBe(9);
    expect(usage.filter((item) => item.scope.startsWith('summary:'))).toHaveLength(1);
    expect(usage.filter((item) => item.scope === 'beat:delivery')).toHaveLength(1);
    for (const item of usage)
      expect(item.usage).toMatchObject({
        inputTokens: 20,
        outputTokens: 5,
        contextMessageSeq: expect.any(Number),
        contextCheckpointSeq: expect.any(Number),
        contextSystemHash: expect.any(String),
        contextEstimateTokens: expect.any(Number),
      });
    expect(usage.filter((item) => item.scope === 'main').at(-1)?.usage.contextCheckpointSeq).toBe(
      checkpoint?.seq
    );
    for (const secret of ['fixture-delivery-secret', 'mcp-delivery-secret']) {
      expect(JSON.stringify(logSpies.map((spy) => spy.mock.calls))).not.toContain(secret);
      expect(JSON.stringify(events)).not.toContain(secret);
      expect(JSON.stringify(store.allUsage('delivery'))).not.toContain(secret);
      for (const scope of new Set(usage.map((item) => item.scope)))
        expect(JSON.stringify(store.archive('delivery', scope))).not.toContain(secret);
    }
    expect(wire.destinations.length).toBeGreaterThan(0);
    expect(wire.destinations.every((origin) => wire.origins.has(origin))).toBe(true);
    expect(wire.rpc.filter((method) => method === 'tools/call')).toHaveLength(1);
  } finally {
    await mcp?.close();
    store?.close();
    await wire.close();
    for (const spy of logSpies) spy.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
