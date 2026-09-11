import { drainAccountsTurn } from './accounts-live-lifecycle.js';
import { assertAccountsConversation } from './accounts-live-oracle.js';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
// Spawned only by accounts-live.test.ts with a closed environment and isolated home.
const wt = process.env.DORKOS_CODEX_ACCOUNTS_SOURCE_ROOT!;
const root = process.env.DORKOS_CODEX_ACCOUNTS_FIXTURE_ROOT!;
assert(wt && root && process.env.DORKOS_CODEX_ACCOUNTS_LIVE === '1');
assert.equal(process.env.DORK_HOME, root + '/private/dork');
assert.equal(process.env.CODEX_HOME, root + '/private/codex');
for (const k of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'])
  assert(!process.env[k]);
const priv = root + '/private';
const cwd = priv + '/agent';
for (const p of [priv, cwd, cwd + '/.dork', process.env.CODEX_HOME!, process.env.DORK_HOME!])
  mkdirSync(p, { recursive: true, mode: 0o700 });
const cleanup: Array<() => void | Promise<void>> = [];
let activeTurn: Promise<void> | undefined;
let stopTurn = async (): Promise<void> => {};
// Parent timeout still gives the SDK a chance to stop its owned child process.
process.once('SIGTERM', () => {
  void (async () => {
    await drainAccountsTurn(stopTurn, activeTurn);
    for (const close of [...cleanup].reverse()) {
      try {
        await close();
      } catch {
        /* Continue cleanup. */
      }
    }
    process.exit(143);
  })();
});
try {
  writeFileSync(
    cwd + '/.dork/agent.json',
    JSON.stringify({
      id: '01JAGENT0000000000000000',
      name: 'Synthetic Accounts Probe',
      runtime: 'codex',
      capabilities: [],
      behavior: { responseMode: 'always' },
      registeredAt: '2026-09-11T00:00:00Z',
      registeredBy: 'test',
    })
  );
  const load = (p: string) => import(pathToFileURL(wt + '/' + p).href);
  const { initConfigManager } = await load('apps/server/src/services/core/config-manager.ts');
  const config = initConfigManager(process.env.DORK_HOME!);
  config.set('runtimes', { ...config.get('runtimes'), dorkosTools: true });
  const { createTestDb } = await load('packages/test-utils/src/db.ts');
  const db = createTestDb();
  const { initAgentIdentityService } = await load(
    'apps/server/src/services/core/agent-identity/index.ts'
  );
  initAgentIdentityService(db);
  const { CodexRuntime } = await load('apps/server/src/services/runtimes/codex/codex-runtime.ts');
  const { CodexThreadMap } = await load('apps/server/src/services/runtimes/codex/thread-map.ts');
  const {
    ConnectorAccessibleConnectionsResponseSchema,
    ConnectorAccessibleOperationsResponseSchema,
    ConnectorExecutionTargetSchema,
  } = await load('packages/shared/src/connector-schemas.ts');
  let turn = 0;
  let account = '01JACCOUNT00000000000000001';
  let revision = 'access-1';
  let revoked = false;
  const bearer = randomUUID();
  const calls: any[] = [];
  const events: any[] = [];
  const snapshots: any[] = [];
  const deliveredContexts: Array<{ turn: number; zeroAccounts: boolean }> = [];
  // Observe the actual SDK input and delegate unchanged to the real SDK.
  const { Thread } = await import('@openai/codex-sdk');
  const originalRunStreamed = Thread.prototype.runStreamed;
  Thread.prototype.runStreamed = function (input, options) {
    const text = typeof input === 'string' ? input : JSON.stringify(input);
    deliveredContexts.push({
      turn,
      zeroAccounts: text.includes('Currently granted accounts for this agent session: 0.'),
    });
    return originalRunStreamed.call(this, input, options);
  };
  cleanup.push(() => {
    Thread.prototype.runStreamed = originalRunStreamed;
  });

  const operations = [
    {
      operationRevisionId: 'fetch-unread-v1',
      toolkit: 'gmail',
      operationSlug: 'GMAIL_FETCH_EMAILS',
      toolkitVersion: 'synthetic-v1',
      capabilityClassification: 'read',
      retryPolicy: 'never',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Gmail search query; is:unread selects unread messages',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      operationRevisionId: 'profile-v1',
      toolkit: 'gmail',
      operationSlug: 'GMAIL_GET_PROFILE',
      toolkitVersion: 'synthetic-v1',
      capabilityClassification: 'read',
      retryPolicy: 'never',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ];
  const tools = [
    {
      name: 'connectors.list_granted_connections',
      description: 'List only accounts currently granted to this agent.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'connectors.list_granted_operations',
      description: 'List exact operation revisions and schemas granted for a listed account.',
      inputSchema: {
        type: 'object',
        properties: { connectionId: { type: 'string' } },
        required: ['connectionId'],
        additionalProperties: false,
      },
    },
    {
      name: 'connectors.execute_read',
      description: 'Execute a granted read operation using its exact revision and schema.',
      inputSchema: {
        type: 'object',
        properties: {
          connectionId: { type: 'string' },
          operationRevisionId: { type: 'string' },
          arguments: { type: 'object' },
        },
        required: ['connectionId', 'operationRevisionId', 'arguments'],
        additionalProperties: false,
      },
    },
  ];
  for (const tool of tools)
    Object.assign(tool, {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    });
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      if (req.headers.authorization !== `Bearer ${bearer}`) {
        res.writeHead(401).end();
        return;
      }
      let raw = '';
      for await (const b of req) {
        raw += b;
        if (raw.length > 100000) throw Error('oversize');
      }
      const q = JSON.parse(raw);
      if (q.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      let result: any = {};
      if (q.method === 'initialize')
        result = {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'synthetic-accounts', version: '1' },
        };
      else if (q.method === 'tools/list') result = { tools: req.url === '/mcp' ? tools : [] };
      else if (q.method === 'tools/call') {
        const name = q.params.name;
        const args = q.params.arguments ?? {};
        const record = { turn, name, args, revoked, dispatched: false };
        calls.push(record);
        let data: any;
        if (name === 'connectors.list_granted_connections')
          data = ConnectorAccessibleConnectionsResponseSchema.parse({
            connections: revoked
              ? []
              : [
                  {
                    connectionId: account,
                    toolkit: 'gmail',
                    label: turn < 3 ? 'Synthetic Inbox A' : 'Synthetic Inbox B',
                    status: 'active',
                    custody: 'managed',
                    reconciliationStatus: 'ready',
                  },
                ],
          });
        else if (name === 'connectors.list_granted_operations')
          data = ConnectorAccessibleOperationsResponseSchema.parse({
            connectionId: args.connectionId,
            operations: !revoked && args.connectionId === account ? operations : [],
          });
        else if (name === 'connectors.execute_read') {
          ConnectorExecutionTargetSchema.parse(args);
          if (revoked || args.connectionId !== account)
            data = {
              result: {
                status: 'error',
                code: 'CONNECTOR_ACCESS_DENIED',
                message: 'Account access is no longer granted.',
              },
            };
          else {
            assert.equal(args.operationRevisionId, 'fetch-unread-v1');
            assert.match(args.arguments.query, /is:unread/);
            record.dispatched = true;
            data = {
              logicalOperationId: randomUUID(),
              attemptCount: 1,
              result: {
                status: 'success',
                data: {
                  messages: [
                    {
                      id: turn < 3 ? 'synthetic-a' : 'synthetic-b',
                      subject: turn < 3 ? 'Cobalt rehearsal' : 'Amber rehearsal',
                      from: 'sender@example.test',
                      snippet: 'Synthetic unread fixture only.',
                    },
                  ],
                },
              },
            };
          }
        } else throw Error('Unexpected tool');
        result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
      } else if (q.method === 'resources/list') result = { resources: [] };
      else if (q.method === 'resources/templates/list') result = { resourceTemplates: [] };
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }));
    } catch {
      res.writeHead(500).end(JSON.stringify({ error: 'synthetic_fixture_error' }));
    }
  });
  cleanup.push(
    () =>
      new Promise<void>((resolve) => (server.listening ? server.close(() => resolve()) : resolve()))
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  const runtime = new CodexRuntime({
    threadMap: new CodexThreadMap(db),
    resolveBinary: async () => process.env.DORKOS_CODEX_ACCOUNTS_BINARY!,
    defaultCwd: cwd,
  });
  runtime.setMeshCore({
    getByPath: (p: string) =>
      p === cwd ? { id: '01JAGENT0000000000000000', name: 'Synthetic Accounts Probe' } : undefined,
    listWithPaths: () => [],
    updateLastSeen: () => {},
  });
  runtime.setConnectorRuntimeTools({
    principals: {
      openTurn: async () => ({
        bindingId: randomUUID(),
        bearer,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        renewalPermit: Object.freeze({}),
      }),
      renew: async () => {
        throw Error('Unexpected renewal');
      },
      resolve: async () => undefined,
      revoke: async () => {},
    },
    listenerUrl: `http://127.0.0.1:${port}/mcp`,
    agentToolsUrl: `http://127.0.0.1:${port}/ordinary`,
    isConnectorCapabilityId: (id: string) => id.startsWith('connectors.'),
    accessSnapshot: async () => {
      const s = { accountCount: revoked ? 0 : 1, revision };
      snapshots.push({ turn, ...s });
      return s;
    },
  });
  const prompts = [
    'What connections do you have?',
    'Please list my unread emails, including their subjects.',
    'Please check my unread emails again using the accounts you can currently access.',
    'Please check my unread emails again.',
  ];
  const session = randomUUID();
  let failure: unknown;
  runtime.ensureSession(session, { cwd, permissionMode: 'default' });
  stopTurn = async () => {
    await runtime.interruptQuery(session);
  };
  cleanup.push(async () => {
    await runtime.interruptQuery(session);
  });
  try {
    for (turn = 1; turn <= 4; turn++) {
      if (turn === 3) {
        account = '01JACCOUNT00000000000000002';
        revision = 'access-2';
      }
      if (turn === 4) {
        revoked = true;
        revision = 'access-3';
      }
      const timeout = setTimeout(() => void runtime.interruptQuery(session), 120000);
      try {
        activeTurn = (async () => {
          for await (const event of runtime.sendMessage(session, prompts[turn - 1], { cwd })) {
            events.push({ turn, event });
          }
        })();
        await activeTurn;
      } finally {
        clearTimeout(timeout);
        activeTurn = undefined;
      }
      writeFileSync(priv + '/events.json', JSON.stringify(events), { mode: 0o600 });
      writeFileSync(priv + '/calls.json', JSON.stringify(calls), { mode: 0o600 });
      if (turn < 4)
        assert(
          calls.some((c) => c.turn === turn),
          'Turn made no observable tool call'
        );
    }
    assertAccountsConversation(calls, events, deliveredContexts);
  } catch (e) {
    failure = e;
  } finally {
    await runtime.interruptQuery(session);
  }
  const proof = {
    passed: !failure,
    turns: Math.min(turn, 4),
    snapshots,
    deliveredContexts,
    calls,
    failure: failure instanceof Error ? failure.message : undefined,
    syntheticOnly: true,
    personalProviderCalls: 0,
    apiPaidKey: false,
  };
  writeFileSync(root + '/result.json', JSON.stringify(proof, null, 2));
  console.log(
    JSON.stringify({
      passed: proof.passed,
      turns: proof.turns,
      calls: calls.length,
      failure: proof.failure,
    })
  );
  process.exitCode = failure ? 1 : 0;
} finally {
  let cleanupFailed = false;
  for (const close of cleanup.reverse()) {
    try {
      await close();
    } catch {
      cleanupFailed = true;
    }
  }
  writeFileSync(root + '/cleanup.json', JSON.stringify({ cleanupFailed }));
  if (cleanupFailed) process.exitCode = 1;
}
