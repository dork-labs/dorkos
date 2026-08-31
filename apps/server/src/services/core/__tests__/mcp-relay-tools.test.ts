import { describe, it, expect, vi } from 'vitest';
import {
  createRelaySendHandler,
  createRelayInboxHandler,
  createRelayListEndpointsHandler,
  createRelayRegisterEndpointHandler,
  createRelayUnregisterEndpointHandler,
  createRelayQueryHandler,
  createRelayDispatchHandler,
  type McpToolDeps,
} from '../../runtimes/claude-code/mcp-tools/index.js';
import {
  resolveSenderIdentity,
  EXTERNAL_MCP_SENDER,
  type SenderIdentity,
} from '../../runtimes/claude-code/mcp-tools/relay-helpers.js';

/** Server-injected identity used in place of the removed self-declared `from`. */
const SENDER: SenderIdentity = { subject: 'relay.agent.sender', agentId: 'sender' };

/**
 * Endpoints the mock relay knows about, keyed exactly the way the real
 * `EndpointRegistry` keys them: a Map on the literal subject string, so a
 * differently-spelled subject resolves to nothing here too.
 */
const MOCK_ENDPOINTS = new Map<string, { subject: string; owner?: string }>([
  // Mesh registers each agent's own endpoint on its behalf, so these carry no
  // recorded owner — the caller's identity is the only proof of ownership.
  ['relay.agent.sender', { subject: 'relay.agent.sender' }],
  ['relay.agent.other', { subject: 'relay.agent.other' }],
  // Registered by SENDER through relay_send_async.
  ['relay.inbox.dispatch.mine', { subject: 'relay.inbox.dispatch.mine', owner: SENDER.subject }],
  // Registered by a different agent.
  [
    'relay.inbox.dispatch.theirs',
    { subject: 'relay.inbox.dispatch.theirs', owner: 'relay.agent.other' },
  ],
  // Registered by the server itself at boot — owned by nobody.
  ['relay.system.console', { subject: 'relay.system.console' }],
]);

function makeMockDeps(relayOverrides?: Record<string, unknown>): McpToolDeps {
  return {
    transcriptReader: {} as McpToolDeps['transcriptReader'],
    defaultCwd: '/test',
    relayCore:
      relayOverrides === undefined
        ? undefined
        : ({
            publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 2 }),
            readInbox: vi.fn().mockReturnValue({ messages: [{ id: 'm1' }], nextCursor: undefined }),
            listEndpoints: vi.fn().mockReturnValue([
              {
                subject: 'relay.agent.a',
                hash: 'h1',
                maildirPath: '/tmp/a',
                registeredAt: new Date().toISOString(),
              },
            ]),
            getDispatchInboxTtlMs: vi.fn().mockReturnValue(30 * 60 * 1000),
            getEndpoint: vi.fn((subject: string) => MOCK_ENDPOINTS.get(subject)),
            registerEndpoint: vi.fn().mockResolvedValue({ subject: 'relay.inbox.new', hash: 'h2' }),
            unregisterEndpoint: vi.fn().mockResolvedValue(true),
            ...relayOverrides,
          } as unknown as McpToolDeps['relayCore']),
  };
}

describe('Relay MCP Tools', () => {
  describe('relay_send', () => {
    it('returns RELAY_DISABLED when relayCore is undefined', async () => {
      const handler = createRelaySendHandler(makeMockDeps(), SENDER);
      const result = await handler({ subject: 'x', payload: {} });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'RELAY_DISABLED' });
    });

    it('publishes message and returns result', async () => {
      const deps = makeMockDeps({});
      const handler = createRelaySendHandler(deps, SENDER);
      const result = await handler({
        subject: 'relay.agent.x',
        payload: { hello: 1 },
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.messageId).toBe('msg-1');
      expect(data.deliveredTo).toBe(2);
      expect(deps.relayCore!.publish).toHaveBeenCalledWith(
        'relay.agent.x',
        { hello: 1 },
        {
          from: 'relay.agent.sender',
          replyTo: undefined,
          budget: undefined,
        }
      );
    });

    it('returns ACCESS_DENIED on access error', async () => {
      const deps = makeMockDeps({
        publish: vi.fn().mockRejectedValue(new Error('Access denied: a -> b')),
      });
      const handler = createRelaySendHandler(deps, SENDER);
      const result = await handler({ subject: 'b', payload: {} });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'ACCESS_DENIED' });
    });

    it('returns INVALID_SUBJECT on invalid subject', async () => {
      const deps = makeMockDeps({
        publish: vi.fn().mockRejectedValue(new Error('Invalid subject: bad!')),
      });
      const handler = createRelaySendHandler(deps, SENDER);
      const result = await handler({ subject: 'bad!', payload: {} });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'INVALID_SUBJECT' });
    });

    it('reports rate-limited drops as REJECTED errors, never queued:true (H3 regression)', async () => {
      const deps = makeMockDeps({
        publish: vi.fn().mockResolvedValue({
          messageId: '',
          deliveredTo: 0,
          rejected: [{ endpointHash: '*', reason: 'rate_limited' }],
        }),
      });
      const handler = createRelaySendHandler(deps, SENDER);
      const result = await handler({ subject: 'relay.agent.x', payload: {} });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data).toMatchObject({
        code: 'REJECTED',
        rejected: [{ endpointHash: '*', reason: 'rate_limited' }],
      });
      expect(data.queued).toBeUndefined();
    });

    it('surfaces partial rejections alongside successful deliveries', async () => {
      const deps = makeMockDeps({
        publish: vi.fn().mockResolvedValue({
          messageId: 'msg-2',
          deliveredTo: 1,
          rejected: [{ endpointHash: 'h9', reason: 'backpressure' }],
        }),
      });
      const handler = createRelaySendHandler(deps, SENDER);
      const result = await handler({ subject: 'relay.agent.x', payload: {} });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data).toMatchObject({
        messageId: 'msg-2',
        deliveredTo: 1,
        queued: false,
        rejected: [{ endpointHash: 'h9', reason: 'backpressure' }],
      });
    });
  });

  describe('relay_inbox', () => {
    it('returns RELAY_DISABLED when relayCore is undefined', async () => {
      const handler = createRelayInboxHandler(makeMockDeps(), SENDER);
      const result = await handler({ endpoint_subject: SENDER.subject });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'RELAY_DISABLED' });
    });

    it('reads inbox and returns messages with payloads', async () => {
      const deps = makeMockDeps({
        readInbox: vi.fn().mockResolvedValue({
          messages: [{ id: 'm1', status: 'pending', payload: { text: 'hello' } }],
          nextCursor: undefined,
        }),
      });
      const handler = createRelayInboxHandler(deps, SENDER);
      const result = await handler({ endpoint_subject: SENDER.subject, limit: 10 });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.messages).toHaveLength(1);
      expect(data.messages[0].payload).toEqual({ text: 'hello' });
      expect(deps.relayCore!.readInbox).toHaveBeenCalledWith(SENDER.subject, {
        limit: 10,
        status: 'pending',
        ack: undefined,
      });
    });

    it('defaults status to "pending" when omitted (DOR-406, matches the HTTP inbox route)', async () => {
      // Purpose: a naive poller that never passes status must never see
      // budget-rejected `failed` messages next to real deliverables.
      const deps = makeMockDeps({
        readInbox: vi.fn().mockResolvedValue({ messages: [], nextCursor: undefined }),
      });
      const handler = createRelayInboxHandler(deps, SENDER);
      await handler({ endpoint_subject: SENDER.subject });
      expect(deps.relayCore!.readInbox).toHaveBeenCalledWith(SENDER.subject, {
        limit: undefined,
        status: 'pending',
        ack: undefined,
      });
    });

    it('forwards an explicit status to readInbox, overriding the pending default', async () => {
      const deps = makeMockDeps({
        readInbox: vi.fn().mockResolvedValue({ messages: [], nextCursor: undefined }),
      });
      const handler = createRelayInboxHandler(deps, SENDER);
      await handler({ endpoint_subject: 'relay.inbox.dispatch.mine', status: 'failed', ack: true });
      expect(deps.relayCore!.readInbox).toHaveBeenCalledWith('relay.inbox.dispatch.mine', {
        limit: undefined,
        status: 'failed',
        ack: true,
      });
    });

    it('forwards status="all" verbatim (opts back into the unfiltered view)', async () => {
      const deps = makeMockDeps({
        readInbox: vi.fn().mockResolvedValue({ messages: [], nextCursor: undefined }),
      });
      const handler = createRelayInboxHandler(deps, SENDER);
      await handler({ endpoint_subject: SENDER.subject, status: 'all' });
      expect(deps.relayCore!.readInbox).toHaveBeenCalledWith(SENDER.subject, {
        limit: undefined,
        status: 'all',
        ack: undefined,
      });
    });

    it("returns ENDPOINT_NOT_FOUND when the caller's own endpoint is not registered", async () => {
      // Ownership passes on identity alone, so an agent whose endpoint has not
      // been registered yet still gets the precise not-found error, not a
      // misleading access denial.
      const deps = makeMockDeps({
        readInbox: vi.fn().mockImplementation(() => {
          throw new Error(`Endpoint not found: ${SENDER.subject}`);
        }),
      });
      const handler = createRelayInboxHandler(deps, SENDER);
      const result = await handler({ endpoint_subject: SENDER.subject });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'ENDPOINT_NOT_FOUND' });
    });
  });

  describe('relay_list_endpoints', () => {
    it('returns RELAY_DISABLED when relayCore is undefined', async () => {
      const handler = createRelayListEndpointsHandler(makeMockDeps());
      const result = await handler();
      expect(result.isError).toBe(true);
    });

    it('lists endpoints', async () => {
      const deps = makeMockDeps({});
      const handler = createRelayListEndpointsHandler(deps);
      const result = await handler();
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(1);
      expect(data.endpoints[0].subject).toBe('relay.agent.a');
    });
  });

  describe('relay_register_endpoint', () => {
    it('returns RELAY_DISABLED when relayCore is undefined', async () => {
      const handler = createRelayRegisterEndpointHandler(makeMockDeps(), SENDER);
      const result = await handler({ subject: 'x' });
      expect(result.isError).toBe(true);
    });

    it('registers endpoint and returns info', async () => {
      const deps = makeMockDeps({});
      const handler = createRelayRegisterEndpointHandler(deps, SENDER);
      const result = await handler({ subject: 'relay.inbox.new', description: 'My bot' });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.endpoint.subject).toBe('relay.inbox.new');
      expect(data.note).toBe('My bot');
    });

    it('returns REGISTRATION_FAILED on error', async () => {
      const deps = makeMockDeps({
        registerEndpoint: vi.fn().mockRejectedValue(new Error('Duplicate')),
      });
      const handler = createRelayRegisterEndpointHandler(deps, SENDER);
      const result = await handler({ subject: 'relay.inbox.dup' });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'REGISTRATION_FAILED' });
    });
  });
});

describe('relay_list_endpoints with type metadata', () => {
  it('returns correct type for dispatch, query, persistent, and agent endpoints', async () => {
    // Purpose: verify inferEndpointType is applied to each endpoint in response.
    const mockEndpoints = [
      {
        subject: 'relay.inbox.dispatch.abc',
        hash: 'h1',
        maildirPath: '/tmp/a',
        registeredAt: new Date().toISOString(),
      },
      {
        subject: 'relay.inbox.query.def',
        hash: 'h2',
        maildirPath: '/tmp/b',
        registeredAt: new Date().toISOString(),
      },
      {
        subject: 'relay.inbox.myagent',
        hash: 'h3',
        maildirPath: '/tmp/c',
        registeredAt: new Date().toISOString(),
      },
      {
        subject: 'relay.agent.lifeOS',
        hash: 'h4',
        maildirPath: '/tmp/d',
        registeredAt: new Date().toISOString(),
      },
      {
        subject: 'relay.human.console.x',
        hash: 'h5',
        maildirPath: '/tmp/e',
        registeredAt: new Date().toISOString(),
      },
    ];
    const mockRelay = {
      listEndpoints: vi.fn().mockReturnValue(mockEndpoints),
      getDispatchInboxTtlMs: vi.fn().mockReturnValue(30 * 60 * 1000),
    };
    const handler = createRelayListEndpointsHandler({
      relayCore: mockRelay as never,
    } as McpToolDeps);
    const result = await handler();
    const parsed = JSON.parse(result.content[0].text);
    const bySubject = Object.fromEntries(
      parsed.endpoints.map((e: { subject: string; type: string }) => [e.subject, e.type])
    );
    expect(bySubject['relay.inbox.dispatch.abc']).toBe('dispatch');
    expect(bySubject['relay.inbox.query.def']).toBe('query');
    expect(bySubject['relay.inbox.myagent']).toBe('persistent');
    expect(bySubject['relay.agent.lifeOS']).toBe('agent');
    expect(bySubject['relay.human.console.x']).toBe('unknown');
  });

  it('returns expiresAt ISO string for dispatch endpoints and null for others', async () => {
    // Purpose: verify TTL transparency field computation.
    const registeredAt = new Date('2026-03-05T10:00:00.000Z').toISOString();
    const ttlMs = 30 * 60 * 1000;
    const mockEndpoints = [
      { subject: 'relay.inbox.dispatch.abc', hash: 'h1', maildirPath: '/tmp/a', registeredAt },
      { subject: 'relay.inbox.query.def', hash: 'h2', maildirPath: '/tmp/b', registeredAt },
    ];
    const mockRelay = {
      listEndpoints: vi.fn().mockReturnValue(mockEndpoints),
      getDispatchInboxTtlMs: vi.fn().mockReturnValue(ttlMs),
    };
    const handler = createRelayListEndpointsHandler({
      relayCore: mockRelay as never,
    } as McpToolDeps);
    const result = await handler();
    const parsed = JSON.parse(result.content[0].text);
    const dispatch = parsed.endpoints.find(
      (e: { subject: string }) => e.subject === 'relay.inbox.dispatch.abc'
    );
    const query = parsed.endpoints.find(
      (e: { subject: string }) => e.subject === 'relay.inbox.query.def'
    );
    // Dispatch: expiresAt = registeredAt + 30min
    expect(dispatch.expiresAt).toBe(
      new Date(new Date(registeredAt).getTime() + ttlMs).toISOString()
    );
    expect(query.expiresAt).toBeNull();
  });
});

describe('relay_send_and_wait progress accumulation', () => {
  it('accumulates progress events and returns them in progress array', async () => {
    // Purpose: verify progress[] is populated when progress events precede agent_result.
    const progressPayload1 = {
      type: 'progress',
      step: 1,
      step_type: 'message',
      text: 'Analyzing...',
      done: false,
    };
    const progressPayload2 = {
      type: 'progress',
      step: 2,
      step_type: 'tool_result',
      text: 'file contents',
      done: false,
    };
    const finalPayload = { type: 'agent_result', text: 'Done.', done: true };

    const mockRelay = {
      registerEndpoint: vi.fn().mockResolvedValue({}),
      publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
      subscribe: vi.fn().mockImplementation((_subject: string, handler: (env: unknown) => void) => {
        // Simulate async delivery of progress events then final result
        setTimeout(
          () => handler({ payload: progressPayload1, from: 'relay.agent.b', id: 'e1' }),
          5
        );
        setTimeout(
          () => handler({ payload: progressPayload2, from: 'relay.agent.b', id: 'e2' }),
          10
        );
        setTimeout(() => handler({ payload: finalPayload, from: 'relay.agent.b', id: 'e3' }), 15);
        return vi.fn(); // unsub
      }),
      unregisterEndpoint: vi.fn().mockResolvedValue(true),
    };
    const handler = createRelayQueryHandler(
      { relayCore: mockRelay as never } as McpToolDeps,
      SENDER
    );
    const result = await handler({
      to_subject: 'relay.agent.b',
      payload: { task: 'do work' },
      timeout_ms: 5000,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.progress).toHaveLength(2);
    expect(parsed.progress[0]).toMatchObject({ type: 'progress', step: 1 });
    expect(parsed.reply).toMatchObject({ type: 'agent_result', done: true });
  });

  it('subscribes to the reply inbox BEFORE publishing (H1 regression)', async () => {
    // Progress events start flowing the moment delivery is accepted; a
    // subscription registered after publish would silently drop them.
    const callOrder: string[] = [];
    const mockRelay = {
      registerEndpoint: vi.fn().mockResolvedValue({}),
      publish: vi.fn().mockImplementation(() => {
        callOrder.push('publish');
        return Promise.resolve({ messageId: 'msg-1', deliveredTo: 1 });
      }),
      subscribe: vi.fn().mockImplementation((_subject: string, handler: (env: unknown) => void) => {
        callOrder.push('subscribe');
        setTimeout(
          () =>
            handler({
              payload: { type: 'agent_result', text: 'ok', done: true },
              from: 'b',
              id: 'e1',
            }),
          5
        );
        return vi.fn();
      }),
      unregisterEndpoint: vi.fn().mockResolvedValue(true),
    };
    const handler = createRelayQueryHandler(
      { relayCore: mockRelay as never } as McpToolDeps,
      SENDER
    );
    await handler({
      to_subject: 'relay.agent.b',
      payload: { task: 'work' },
      timeout_ms: 5000,
    });
    expect(callOrder).toEqual(['subscribe', 'publish']);
  });

  it('returns empty progress array when first message is non-progress (non-CCA compat)', async () => {
    // Purpose: backward compat — agents that reply with a plain payload still resolve correctly.
    const plainPayload = { text: 'hello' };

    const mockRelay = {
      registerEndpoint: vi.fn().mockResolvedValue({}),
      publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
      subscribe: vi.fn().mockImplementation((_subject: string, handler: (env: unknown) => void) => {
        setTimeout(() => handler({ payload: plainPayload, from: 'relay.agent.b', id: 'e1' }), 5);
        return vi.fn();
      }),
      unregisterEndpoint: vi.fn().mockResolvedValue(true),
    };
    const handler = createRelayQueryHandler(
      { relayCore: mockRelay as never } as McpToolDeps,
      SENDER
    );
    const result = await handler({
      to_subject: 'relay.agent.b',
      payload: { task: 'quick question' },
      timeout_ms: 5000,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.progress).toEqual([]);
    expect(parsed.reply).toEqual(plainPayload);
  });
});

describe('relay_send_and_wait terminal error handling', () => {
  it('returns AGENT_ERROR (not a success-shaped reply) when the turn ends with an error event', async () => {
    // CCA publishes { type: 'error', data: { message } } before the synthesized
    // done on a crashed/aborted turn. That must fail the call — a success-shaped
    // reply would pass partial output off as a completed answer.
    const mockRelay = {
      registerEndpoint: vi.fn().mockResolvedValue({}),
      publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
      subscribe: vi.fn().mockImplementation((_subject: string, handler: (env: unknown) => void) => {
        setTimeout(
          () =>
            handler({
              payload: { type: 'progress', step: 1, step_type: 'message', text: 'p', done: false },
              from: 'relay.agent.b',
              id: 'e1',
            }),
          5
        );
        setTimeout(
          () =>
            handler({
              payload: { type: 'error', data: { message: 'SDK stream error' } },
              from: 'relay.agent.b',
              id: 'e2',
            }),
          10
        );
        return vi.fn();
      }),
      unregisterEndpoint: vi.fn().mockResolvedValue(true),
    };
    const handler = createRelayQueryHandler(
      { relayCore: mockRelay as never } as McpToolDeps,
      SENDER
    );
    const result = await handler({
      to_subject: 'relay.agent.b',
      payload: { task: 'work' },
      timeout_ms: 5000,
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.code).toBe('AGENT_ERROR');
    expect(parsed.error).toContain('SDK stream error');
    expect(parsed.progress).toHaveLength(1);
    expect(parsed.reply).toBeUndefined();
    // The prompt block promises partialText on AGENT_ERROR without qualifying
    // it, so this branch owes it too. The terminal error event carries no text
    // of its own — the message progress steps ARE what the caller was streamed.
    expect(parsed.partialText).toBe('p');
    expect(parsed.replyMessageId).toBe('e2');
  });

  // DOR-1337 (F6). The other terminal shape: the turn hit an upstream failure
  // mid-stream and still ended normally, so CCA publishes no error event at all
  // — only the final agent_result, now carrying `error`. Before this, the caller
  // read `{"reply":{"type":"agent_result","text":"","done":true}}` and had no
  // way to tell a crash from an empty answer.
  it('returns AGENT_ERROR when the final agent_result carries an error', async () => {
    const mockRelay = {
      registerEndpoint: vi.fn().mockResolvedValue({}),
      publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
      subscribe: vi.fn().mockImplementation((_subject: string, handler: (env: unknown) => void) => {
        setTimeout(
          () =>
            handler({
              payload: {
                type: 'agent_result',
                text: 'got this far',
                done: true,
                error: 'API Error: 500',
              },
              from: 'relay.agent.team.b',
              id: 'e1',
            }),
          5
        );
        return vi.fn();
      }),
      unregisterEndpoint: vi.fn().mockResolvedValue(true),
    };
    const handler = createRelayQueryHandler(
      { relayCore: mockRelay as never } as McpToolDeps,
      SENDER
    );
    const result = await handler({
      to_subject: 'relay.agent.team.b',
      payload: { task: 'work' },
      timeout_ms: 5000,
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.code).toBe('AGENT_ERROR');
    expect(parsed.error).toContain('API Error: 500');
    expect(parsed.partialText).toBe('got this far');
    expect(parsed.from).toBe('relay.agent.team.b');
    // Never success-shaped: a `reply` field is what a caller reads as an answer.
    expect(parsed.reply).toBeUndefined();
  });

  it('still returns a success-shaped reply for an error-free agent_result', async () => {
    const mockRelay = {
      registerEndpoint: vi.fn().mockResolvedValue({}),
      publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
      subscribe: vi.fn().mockImplementation((_subject: string, handler: (env: unknown) => void) => {
        setTimeout(
          () =>
            handler({
              payload: { type: 'agent_result', text: 'the answer', done: true },
              from: 'relay.agent.team.b',
              id: 'e1',
            }),
          5
        );
        return vi.fn();
      }),
      unregisterEndpoint: vi.fn().mockResolvedValue(true),
    };
    const handler = createRelayQueryHandler(
      { relayCore: mockRelay as never } as McpToolDeps,
      SENDER
    );
    const result = await handler({
      to_subject: 'relay.agent.team.b',
      payload: {},
      timeout_ms: 5000,
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.reply).toMatchObject({ type: 'agent_result', text: 'the answer' });
  });
});

describe('ACCESS_DENIED remediation hint', () => {
  it('relay_send attaches the cross-namespace hint on access denials', async () => {
    const deps = makeMockDeps({
      publish: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'Access denied: relay.agent.a.X -> relay.agent.b.Y (rule: relay.agent.a.* -> relay.agent.>)'
          )
        ),
    });
    const handler = createRelaySendHandler(deps, SENDER);
    const result = await handler({ subject: 'relay.agent.b.Y', payload: {} });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.code).toBe('ACCESS_DENIED');
    expect(parsed.hint).toContain('denied by default');
    // Both remedies, named the way the UI names them (DOR-1338).
    expect(parsed.hint).toContain('Let all my agents talk to each other');
    expect(parsed.hint).toContain('Team → Access');
    expect(parsed.hint).toContain('this namespace pair');
  });

  it('non-access failures carry no hint', async () => {
    const deps = makeMockDeps({
      publish: vi.fn().mockRejectedValue(new Error('Invalid subject: bad!')),
    });
    const handler = createRelaySendHandler(deps, SENDER);
    const result = await handler({ subject: 'bad!', payload: {} });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.code).toBe('INVALID_SUBJECT');
    expect(parsed.hint).toBeUndefined();
  });
});

describe('server-injected sender identity (M6)', () => {
  it('relay_send publishes with the injected identity, ignoring any spoofed from in args', async () => {
    const deps = makeMockDeps({});
    const handler = createRelaySendHandler(deps, { subject: 'relay.agent.ns.trusted' });
    // A malicious caller tries to assert another agent's identity. The `from`
    // is not part of the tool schema; even if smuggled in, it is ignored.
    await handler({
      subject: 'relay.agent.victim',
      payload: {},
      from: 'relay.agent.ns.someone-else',
    } as Parameters<typeof handler>[0]);

    expect(deps.relayCore!.publish).toHaveBeenCalledWith(
      'relay.agent.victim',
      {},
      expect.objectContaining({ from: 'relay.agent.ns.trusted' })
    );
  });
});

// ---------------------------------------------------------------------------
// Bare-agent-id targets (DOR-1337 / F5)
//
// The canonical inbox is `relay.agent.{namespace}.{agentId}` and every allow
// rule is written against it, so a caller that addressed a peer by id alone hit
// the blanket cross-namespace deny no matter what the operator had allowed. The
// send tools now rewrite that one shape — and only when the id is really an
// agent — before the ACL sees it. The pass-through half matters just as much:
// `relay.agent.<sessionId>` is the legacy session-routing address and must keep
// meaning what it says.
// ---------------------------------------------------------------------------
describe('bare relay.agent.<agentId> targets are canonicalized before publish', () => {
  /** Deps whose mesh knows exactly one agent, `a1`, living in namespace `team`. */
  function depsKnowingA1(relayOverrides: Record<string, unknown> = {}): McpToolDeps {
    const deps = makeMockDeps(relayOverrides);
    return {
      ...deps,
      meshCore: {
        getSubject: vi.fn((agentId: string) =>
          agentId === 'a1' ? 'relay.agent.team.a1' : undefined
        ),
      } as unknown as McpToolDeps['meshCore'],
    };
  }

  it('relay_send publishes to the agent full address, not the two-segment one it was given', async () => {
    const deps = depsKnowingA1();
    await createRelaySendHandler(deps, SENDER)({ subject: 'relay.agent.a1', payload: { q: 1 } });

    expect(deps.relayCore!.publish).toHaveBeenCalledWith(
      'relay.agent.team.a1',
      { q: 1 },
      expect.anything()
    );
  });

  it('relay_send_async publishes to the full address', async () => {
    const deps = depsKnowingA1();
    await createRelayDispatchHandler(
      deps,
      SENDER
    )({
      to_subject: 'relay.agent.a1',
      payload: { q: 1 },
    });

    expect(deps.relayCore!.publish).toHaveBeenCalledWith(
      'relay.agent.team.a1',
      { q: 1 },
      expect.objectContaining({ from: SENDER.subject })
    );
  });

  it('relay_send_and_wait publishes to the full address', async () => {
    const deps = depsKnowingA1({
      subscribe: vi.fn().mockImplementation((_s: string, handler: (env: unknown) => void) => {
        setTimeout(
          () => handler({ payload: { type: 'agent_result', text: 'ok', done: true }, from: 'b' }),
          5
        );
        return vi.fn();
      }),
    });
    await createRelayQueryHandler(
      deps,
      SENDER
    )({
      to_subject: 'relay.agent.a1',
      payload: { q: 1 },
      timeout_ms: 2000,
    });

    expect(deps.relayCore!.publish).toHaveBeenCalledWith(
      'relay.agent.team.a1',
      { q: 1 },
      expect.objectContaining({ replyTo: expect.stringContaining('relay.inbox.query.') })
    );
  });

  it('leaves a legacy relay.agent.<sessionId> alone — a session id is not an agent id', async () => {
    const deps = depsKnowingA1();
    const sessionSubject = 'relay.agent.7f3c9a12-0000-4000-8000-000000000000';
    await createRelaySendHandler(deps, SENDER)({ subject: sessionSubject, payload: {} });

    expect(deps.relayCore!.publish).toHaveBeenCalledWith(sessionSubject, {}, expect.anything());
  });

  it('leaves an already-canonical four-segment subject alone', async () => {
    const deps = depsKnowingA1();
    await createRelaySendHandler(deps, SENDER)({ subject: 'relay.agent.team.a1', payload: {} });

    expect(deps.relayCore!.publish).toHaveBeenCalledWith(
      'relay.agent.team.a1',
      {},
      expect.anything()
    );
  });

  it('leaves a runtime-scoped session subject alone', async () => {
    const deps = depsKnowingA1();
    const runtimeScoped = 'relay.agent.claude-code.a1';
    await createRelaySendHandler(deps, SENDER)({ subject: runtimeScoped, payload: {} });

    expect(deps.relayCore!.publish).toHaveBeenCalledWith(runtimeScoped, {}, expect.anything());
  });

  it('leaves every non-agent subject alone', async () => {
    const deps = depsKnowingA1();
    for (const subject of ['relay.inbox.a1', 'relay.system.console', 'relay.human.console.c1']) {
      await createRelaySendHandler(deps, SENDER)({ subject, payload: {} });
      expect(deps.relayCore!.publish).toHaveBeenCalledWith(subject, {}, expect.anything());
    }
  });

  it('leaves the subject alone when Mesh is not wired at all', async () => {
    const deps = makeMockDeps({});
    await createRelaySendHandler(deps, SENDER)({ subject: 'relay.agent.a1', payload: {} });

    expect(deps.relayCore!.publish).toHaveBeenCalledWith('relay.agent.a1', {}, expect.anything());
  });
});

describe('resolveSenderIdentity', () => {
  // The registry-backed behavior (nested layouts, explicit-namespace
  // manifests, and the invariant `resolveSenderIdentity(cwd).subject ===
  // inspect(agentId).relaySubject`) is proven against a REAL MeshCore +
  // RelayCore in packages/mesh/src/__tests__/identity-access.integration.test.ts.
  // These unit tests pin the delegation contract: identity comes from
  // `getSubjectByPath()` (the un-stripped registry entry). `getByPath()` must
  // NOT be consulted — its public manifest has `namespace` stripped, which
  // would silently degrade the subject to basename(cwd) and match no rule.
  it('delegates to meshCore.getSubjectByPath, never the namespace-stripped getByPath', () => {
    const getSubjectByPath = vi
      .fn()
      .mockReturnValue({ subject: 'relay.agent.team.a1', agentId: 'a1' });
    // Mirrors the real getByPath contract: public manifest, namespace stripped.
    const getByPath = vi.fn().mockReturnValue({ id: 'a1', name: 'my-agent' });
    const deps = {
      meshCore: { getSubjectByPath, getByPath } as unknown as McpToolDeps['meshCore'],
    } as McpToolDeps;

    const identity = resolveSenderIdentity(deps, '/projects/my-agent');

    expect(getSubjectByPath).toHaveBeenCalledWith('/projects/my-agent');
    expect(getByPath).not.toHaveBeenCalled();
    expect(identity).toEqual({ subject: 'relay.agent.team.a1', agentId: 'a1' });
  });

  it('falls back to a non-agent session identity when cwd has no registered agent', () => {
    const deps = {
      meshCore: {
        getSubjectByPath: vi.fn().mockReturnValue(undefined),
      } as unknown as McpToolDeps['meshCore'],
    } as McpToolDeps;

    const identity = resolveSenderIdentity(deps, '/tmp/scratch');
    // A hash of the FULL cwd (DOR-514), not `path.basename(cwd)` — see the
    // next test for why that distinction is the whole point.
    expect(identity.subject).toBe('relay.session.e549f2e8c418');
    expect(identity.agentId).toBeUndefined();
  });

  it('gives two projects that share a leaf directory name distinct identities (DOR-514)', () => {
    // Before this, the non-agent session subject was `relay.session.${
    // path.basename(cwd)}`, so `/a/project` and `/b/project` — two unrelated
    // directories that happen to share a leaf name — collided on one identity.
    // No agent ACL rule keys on this subject, so the collision was mild rather
    // than the in-session escalation DOR-506 closed, but it is cheap to fix.
    const deps = {
      meshCore: {
        getSubjectByPath: vi.fn().mockReturnValue(undefined),
      } as unknown as McpToolDeps['meshCore'],
    } as McpToolDeps;

    const a = resolveSenderIdentity(deps, '/a/project');
    const b = resolveSenderIdentity(deps, '/b/project');

    expect(a.subject).not.toBe(b.subject);
    expect(a.subject.startsWith('relay.session.')).toBe(true);
    expect(b.subject.startsWith('relay.session.')).toBe(true);
  });

  it('uses the external principal when there is no session (undefined cwd)', () => {
    const identity = resolveSenderIdentity({} as McpToolDeps, undefined);
    expect(identity.subject).toBe(EXTERNAL_MCP_SENDER);
    expect(identity.agentId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Endpoint ownership (DOR-506)
//
// `endpoint_subject` and `subject` are model-supplied. Before this gate, agent
// A could name agent B's endpoint and read B's pending mail, and `ack: true`
// unlinked each payload file on the way out, so one call drained and destroyed
// mail B had never seen. `relay_unregister_endpoint` was worse still: it
// deletes the whole Maildir tree.
// ---------------------------------------------------------------------------

describe('relay endpoint ownership (DOR-506)', () => {
  /** A second agent, used as the victim whose mail must stay unreachable. */
  const OTHER: SenderIdentity = { subject: 'relay.agent.other', agentId: 'other' };

  /** Mock relay whose registry resolves ANY subject to an endpoint owned by `owner`. */
  function depsResolvingTo(owner: string | undefined): McpToolDeps {
    return makeMockDeps({
      getEndpoint: vi.fn((subject: string) => ({ subject, owner })),
    });
  }

  describe('the legitimate flow still works', () => {
    it("reads the caller's own agent inbox, which Mesh registered with no recorded owner", async () => {
      const deps = makeMockDeps({
        readInbox: vi.fn().mockResolvedValue({ messages: [{ id: 'm1' }] }),
      });
      const result = await createRelayInboxHandler(
        deps,
        SENDER
      )({
        endpoint_subject: SENDER.subject,
        ack: true,
      });
      expect(result.isError).toBeUndefined();
      expect(deps.relayCore!.readInbox).toHaveBeenCalledTimes(1);
    });

    it('reads and acks a dispatch inbox the caller registered', async () => {
      const deps = makeMockDeps({
        readInbox: vi.fn().mockResolvedValue({ messages: [{ id: 'm1' }] }),
      });
      const result = await createRelayInboxHandler(
        deps,
        SENDER
      )({
        endpoint_subject: 'relay.inbox.dispatch.mine',
        ack: true,
      });
      expect(result.isError).toBeUndefined();
      expect(deps.relayCore!.readInbox).toHaveBeenCalledTimes(1);
    });

    it('removes a dispatch inbox the caller registered', async () => {
      const deps = makeMockDeps({});
      const result = await createRelayUnregisterEndpointHandler(
        deps,
        SENDER
      )({
        subject: 'relay.inbox.dispatch.mine',
      });
      expect(result.isError).toBeUndefined();
      expect(deps.relayCore!.unregisterEndpoint).toHaveBeenCalledWith('relay.inbox.dispatch.mine');
    });
  });

  describe('the cross-agent read is refused', () => {
    it("refuses another agent's Mesh-registered inbox and never reads it", async () => {
      const deps = makeMockDeps({});
      const result = await createRelayInboxHandler(
        deps,
        SENDER
      )({
        endpoint_subject: OTHER.subject,
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        code: 'ENDPOINT_ACCESS_DENIED',
      });
      expect(deps.relayCore!.readInbox).not.toHaveBeenCalled();
    });

    it("refuses ack:true on another agent's dispatch inbox, so nothing is destroyed", async () => {
      // The destructive case: ack unlinks each payload file with no undo.
      const deps = makeMockDeps({});
      const result = await createRelayInboxHandler(
        deps,
        SENDER
      )({
        endpoint_subject: 'relay.inbox.dispatch.theirs',
        ack: true,
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        code: 'ENDPOINT_ACCESS_DENIED',
      });
      expect(deps.relayCore!.readInbox).not.toHaveBeenCalled();
    });

    it('refuses an endpoint that records no owner at all, rather than treating it as unowned-so-public', async () => {
      // The regression this repo already shipped once (ADR 260725-133220): a
      // gate that allows when nothing resolves. `relay.system.console` is
      // registered by the server, so it records no owner — that must mean
      // nobody owns it, not everybody. Only three production sites register
      // without an owner, and one of them is every Mesh agent endpoint.
      const deps = makeMockDeps({});
      const result = await createRelayInboxHandler(
        deps,
        SENDER
      )({
        endpoint_subject: 'relay.system.console',
        ack: true,
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        code: 'ENDPOINT_ACCESS_DENIED',
      });
      expect(deps.relayCore!.readInbox).not.toHaveBeenCalled();
    });

    it("refuses the external MCP principal on an agent's inbox", async () => {
      // The external /mcp surface shares one fixed identity. It owns whatever
      // it registered and nothing else; it must never inherit agent mail.
      const deps = makeMockDeps({});
      const external: SenderIdentity = { subject: EXTERNAL_MCP_SENDER };
      const result = await createRelayInboxHandler(
        deps,
        external
      )({
        endpoint_subject: SENDER.subject,
        ack: true,
      });
      expect(result.isError).toBe(true);
      expect(deps.relayCore!.readInbox).not.toHaveBeenCalled();
    });

    it('grants nothing to a caller with an empty subject, even against an empty owner', async () => {
      // Belt and braces: resolveSenderIdentity never yields an empty subject,
      // but if one ever slipped through it must not match an empty owner.
      const deps = depsResolvingTo('');
      const result = await createRelayInboxHandler(deps, { subject: '' })({
        endpoint_subject: '',
      });
      expect(result.isError).toBe(true);
      expect(deps.relayCore!.readInbox).not.toHaveBeenCalled();
    });

    it('reports an honest miss for an unregistered subject rather than a denial', async () => {
      // The guard runs only where there is something to disclose. An
      // unregistered subject resolves to no endpoint, and readInbox performs the
      // SAME registry lookup and throws ENDPOINT_NOT_FOUND, so the two can never
      // disagree. Reporting the miss is what keeps an idempotent cleanup loop
      // from spinning after a restart.
      const deps = makeMockDeps({
        readInbox: vi.fn().mockImplementation(() => {
          throw new Error('Endpoint not found: relay.inbox.dispatch.never-registered');
        }),
      });
      const result = await createRelayInboxHandler(
        deps,
        SENDER
      )({
        endpoint_subject: 'relay.inbox.dispatch.never-registered',
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'ENDPOINT_NOT_FOUND' });
    });

    it('reports an honest miss when unregistering something that is not registered', async () => {
      const deps = makeMockDeps({ unregisterEndpoint: vi.fn().mockResolvedValue(false) });
      const result = await createRelayUnregisterEndpointHandler(
        deps,
        SENDER
      )({
        subject: 'relay.inbox.dispatch.long-gone',
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'ENDPOINT_NOT_FOUND' });
    });
  });

  describe("near-miss spellings of the CALLER's own subject cannot slip past the check", () => {
    // Each row crosses BOTH operands of the predicate: the subject is a near-miss
    // of the CALLER's own address, while the endpoint is owned by a third party.
    // So `subject === caller` is the only rule that could fire, and any predicate
    // looser than exact equality on that operand lets the row through. An earlier
    // version of this table used near-misses of the VICTIM's subject against a
    // victim-owned endpoint, where neither operand related to the caller, so
    // every row was refused by any predicate short of always-allow and the table
    // discriminated nothing.
    //
    // Scope, stated precisely: this is a unit test of the ownership decision at
    // the handler boundary. `depsResolvingTo` makes the registry resolve ANY
    // string so the comparison is the only variable. It is NOT a claim about
    // which error production returns for these spellings. Most are unregistrable
    // (whitespace and wildcards fail `validateSubject`; a case variant of a live
    // endpoint is refused by the collision rule), so in production the registry
    // returns `undefined`, the guard is skipped, and the caller gets
    // ENDPOINT_NOT_FOUND — see "reports an honest miss for an unregistered
    // subject" above. Both outcomes disclose nothing; only this one turns on the
    // comparison, which is why it is the one pinned here.
    const callerNearMisses: Array<[label: string, subject: string]> = [
      ['upper case', 'RELAY.AGENT.SENDER'],
      ['mixed case', 'Relay.Agent.Sender'],
      ['leading whitespace', ' relay.agent.sender'],
      ['trailing whitespace', 'relay.agent.sender '],
      ['trailing separator', 'relay.agent.sender.'],
      ['double separator', 'relay.agent..sender'],
      ['caller subject extended by a character', 'relay.agent.senderx'],
      ['caller subject truncated', 'relay.agent.sende'],
      ['caller subject extended by a token', 'relay.agent.sender.private'],
      ['single-token wildcard', 'relay.agent.*'],
      ['multi-token wildcard', 'relay.agent.>'],
      ['caller subject embedded in a longer subject', 'relay.agent.other.relay.agent.sender'],
    ];

    for (const [label, subject] of callerNearMisses) {
      it(`refuses reading ${label}: ${JSON.stringify(subject)}`, async () => {
        const deps = depsResolvingTo(OTHER.subject);
        const result = await createRelayInboxHandler(
          deps,
          SENDER
        )({
          endpoint_subject: subject,
          ack: true,
        });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          code: 'ENDPOINT_ACCESS_DENIED',
        });
        expect(deps.relayCore!.readInbox).not.toHaveBeenCalled();
      });

      it(`refuses unregistering ${label}: ${JSON.stringify(subject)}`, async () => {
        const deps = depsResolvingTo(OTHER.subject);
        const result = await createRelayUnregisterEndpointHandler(deps, SENDER)({ subject });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          code: 'ENDPOINT_ACCESS_DENIED',
        });
        expect(deps.relayCore!.unregisterEndpoint).not.toHaveBeenCalled();
      });
    }

    it('allows the exact spelling against the same mock, so the rows differ only by spelling', async () => {
      // The control that makes the rows above meaningful: same third-party
      // owner, same resolving mock, only the spelling is exact. Rule 1 grants it
      // because your own address is yours whatever owner is recorded, and the
      // reserved-namespace rule is what stops a foreign owner ever being
      // recorded on an agent address in the first place.
      const deps = makeMockDeps({
        getEndpoint: vi.fn((subject: string) => ({ subject, owner: OTHER.subject })),
        readInbox: vi.fn().mockResolvedValue({ messages: [] }),
      });
      const result = await createRelayInboxHandler(
        deps,
        SENDER
      )({
        endpoint_subject: SENDER.subject,
        ack: true,
      });
      expect(result.isError).toBeUndefined();
      expect(deps.relayCore!.readInbox).toHaveBeenCalledTimes(1);
    });
  });

  describe("a near-miss of the caller's OWN subject is not the caller's subject", () => {
    // These isolate the comparison from the registry lookup from the other side:
    // the endpoint resolves to an owner that is a near-miss of the caller, so
    // anything that trims, case-folds, or prefix-matches lets them through.
    const selfNearMisses: Array<[label: string, subject: string, owner: string]> = [
      ['upper-cased own subject', 'RELAY.AGENT.SENDER', 'RELAY.AGENT.SENDER'],
      ['own subject with trailing space', 'relay.agent.sender ', 'relay.agent.sender '],
      ['own subject with leading space', ' relay.agent.sender', ' relay.agent.sender'],
      ['own subject with a trailing dot', 'relay.agent.sender.', 'relay.agent.sender.'],
      [
        'own subject extended by a token',
        'relay.agent.sender.private',
        'relay.agent.sender.private',
      ],
      ['owner recorded in a different case', 'relay.inbox.notes', 'RELAY.AGENT.SENDER'],
      ['owner recorded with stray whitespace', 'relay.inbox.notes', ' relay.agent.sender '],
      [
        'owner that merely starts with the caller subject',
        'relay.inbox.notes',
        'relay.agent.senderx',
      ],
    ];

    for (const [label, subject, owner] of selfNearMisses) {
      it(`refuses ${label}`, async () => {
        const deps = depsResolvingTo(owner);
        const result = await createRelayInboxHandler(
          deps,
          SENDER
        )({
          endpoint_subject: subject,
          ack: true,
        });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          code: 'ENDPOINT_ACCESS_DENIED',
        });
        expect(deps.relayCore!.readInbox).not.toHaveBeenCalled();
      });
    }

    it('still allows the exact spelling, so the near-miss cases are not passing for the wrong reason', async () => {
      const deps = makeMockDeps({
        getEndpoint: vi.fn((s: string) => ({ subject: s, owner: SENDER.subject })),
        readInbox: vi.fn().mockResolvedValue({ messages: [] }),
      });
      const result = await createRelayInboxHandler(
        deps,
        SENDER
      )({
        endpoint_subject: 'relay.inbox.notes',
        ack: true,
      });
      expect(result.isError).toBeUndefined();
      expect(deps.relayCore!.readInbox).toHaveBeenCalledTimes(1);
    });
  });

  describe('relay_list_endpoints does not hand out owners', () => {
    it('omits owner from every listed endpoint', async () => {
      // Agents need it for nothing, and naming every mailbox's owner in one
      // unrestricted call is the reconnaissance step for targeting one.
      const deps = makeMockDeps({
        listEndpoints: vi.fn().mockReturnValue([
          {
            subject: 'relay.inbox.dispatch.theirs',
            hash: 'relay.inbox.dispatch.theirs',
            maildirPath: '/tmp/x',
            registeredAt: new Date().toISOString(),
            owner: OTHER.subject,
          },
        ]),
      });
      const result = await createRelayListEndpointsHandler(deps)();
      const data = JSON.parse(result.content[0].text) as {
        endpoints: Array<Record<string, unknown>>;
      };
      expect(data.endpoints).toHaveLength(1);
      expect(data.endpoints[0]).not.toHaveProperty('owner');
      expect(data.endpoints[0].subject).toBe('relay.inbox.dispatch.theirs');
    });
  });

  describe('server-managed namespaces cannot be claimed', () => {
    // Registering another agent's address would INTERCEPT its mail, not merely
    // read it, so this is refused before the registry is touched at all.
    const reserved = [
      'relay.agent.other',
      'relay.system.console',
      'relay.human.console.abc',
      'relay.inbox.dispatch.forged',
      'relay.inbox.query.forged',
    ];

    for (const subject of reserved) {
      it(`refuses relay_register_endpoint for ${subject}`, async () => {
        const deps = makeMockDeps({});
        const result = await createRelayRegisterEndpointHandler(deps, SENDER)({ subject });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'RESERVED_SUBJECT' });
        expect(deps.relayCore!.registerEndpoint).not.toHaveBeenCalled();
      });
    }

    it('allows an agent to register its own address', async () => {
      const deps = makeMockDeps({});
      const result = await createRelayRegisterEndpointHandler(
        deps,
        SENDER
      )({
        subject: SENDER.subject,
      });
      expect(result.isError).toBeUndefined();
    });

    it('allows the relay.inbox.* namespace agents are told to use', async () => {
      const deps = makeMockDeps({});
      const result = await createRelayRegisterEndpointHandler(
        deps,
        SENDER
      )({
        subject: 'relay.inbox.sender',
      });
      expect(result.isError).toBeUndefined();
    });

    it('maps an owner conflict from the registry to ENDPOINT_ACCESS_DENIED', async () => {
      const deps = makeMockDeps({
        registerEndpoint: vi
          .fn()
          .mockRejectedValue(new Error('Endpoint belongs to another owner: relay.inbox.alice')),
      });
      const result = await createRelayRegisterEndpointHandler(
        deps,
        SENDER
      )({
        subject: 'relay.inbox.alice',
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        code: 'ENDPOINT_ACCESS_DENIED',
      });
    });

    it('maps a case collision from the registry to ENDPOINT_ACCESS_DENIED', async () => {
      const deps = makeMockDeps({
        registerEndpoint: vi
          .fn()
          .mockRejectedValue(
            new Error('Subject collides with existing endpoint "relay.inbox.alice"')
          ),
      });
      const result = await createRelayRegisterEndpointHandler(
        deps,
        SENDER
      )({
        subject: 'relay.inbox.ALICE',
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        code: 'ENDPOINT_ACCESS_DENIED',
      });
    });
  });

  describe('ownership is recorded at registration', () => {
    it('relay_register_endpoint records the caller as the owner', async () => {
      const deps = makeMockDeps({});
      await createRelayRegisterEndpointHandler(deps, SENDER)({ subject: 'relay.inbox.notes' });
      expect(deps.relayCore!.registerEndpoint).toHaveBeenCalledWith('relay.inbox.notes', {
        owner: SENDER.subject,
      });
    });

    it('relay_send_async records the caller as the dispatch inbox owner', async () => {
      const deps = makeMockDeps({
        publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
      });
      await createRelayDispatchHandler(
        deps,
        SENDER
      )({
        to_subject: OTHER.subject,
        payload: { task: 'work' },
      });
      expect(deps.relayCore!.registerEndpoint).toHaveBeenCalledWith(
        expect.stringMatching(/^relay\.inbox\.dispatch\./),
        { owner: SENDER.subject }
      );
    });

    it('relay_send_and_wait records the caller as the reply inbox owner', async () => {
      const deps = makeMockDeps({
        publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
        subscribe: vi.fn().mockImplementation((_s: string, handler: (env: unknown) => void) => {
          setTimeout(() => handler({ payload: { done: true }, from: OTHER.subject, id: 'e1' }), 1);
          return vi.fn();
        }),
      });
      await createRelayQueryHandler(
        deps,
        SENDER
      )({
        to_subject: OTHER.subject,
        payload: { task: 'work' },
        timeout_ms: 5000,
      });
      expect(deps.relayCore!.registerEndpoint).toHaveBeenCalledWith(
        expect.stringMatching(/^relay\.inbox\.query\./),
        { owner: SENDER.subject }
      );
    });
  });
});
