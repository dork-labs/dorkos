import { describe, it, expect, vi } from 'vitest';
import {
  createRelaySendHandler,
  createRelayInboxHandler,
  createRelayListEndpointsHandler,
  createRelayRegisterEndpointHandler,
  createRelayQueryHandler,
  type McpToolDeps,
} from '../../runtimes/claude-code/mcp-tools/index.js';
import {
  resolveSenderIdentity,
  EXTERNAL_MCP_SENDER,
  type SenderIdentity,
} from '../../runtimes/claude-code/mcp-tools/relay-helpers.js';

/** Server-injected identity used in place of the removed self-declared `from`. */
const SENDER: SenderIdentity = { subject: 'relay.agent.sender', agentId: 'sender' };

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
            registerEndpoint: vi.fn().mockResolvedValue({ subject: 'relay.agent.new', hash: 'h2' }),
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
      const handler = createRelayInboxHandler(makeMockDeps());
      const result = await handler({ endpoint_subject: 'x' });
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
      const handler = createRelayInboxHandler(deps);
      const result = await handler({ endpoint_subject: 'relay.agent.a', limit: 10 });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.messages).toHaveLength(1);
      expect(data.messages[0].payload).toEqual({ text: 'hello' });
      expect(deps.relayCore!.readInbox).toHaveBeenCalledWith('relay.agent.a', {
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
      const handler = createRelayInboxHandler(deps);
      await handler({ endpoint_subject: 'relay.agent.a' });
      expect(deps.relayCore!.readInbox).toHaveBeenCalledWith('relay.agent.a', {
        limit: undefined,
        status: 'pending',
        ack: undefined,
      });
    });

    it('forwards an explicit status to readInbox, overriding the pending default', async () => {
      const deps = makeMockDeps({
        readInbox: vi.fn().mockResolvedValue({ messages: [], nextCursor: undefined }),
      });
      const handler = createRelayInboxHandler(deps);
      await handler({ endpoint_subject: 'relay.inbox.dispatch.x', status: 'failed', ack: true });
      expect(deps.relayCore!.readInbox).toHaveBeenCalledWith('relay.inbox.dispatch.x', {
        limit: undefined,
        status: 'failed',
        ack: true,
      });
    });

    it('forwards status="all" verbatim (opts back into the unfiltered view)', async () => {
      const deps = makeMockDeps({
        readInbox: vi.fn().mockResolvedValue({ messages: [], nextCursor: undefined }),
      });
      const handler = createRelayInboxHandler(deps);
      await handler({ endpoint_subject: 'relay.agent.a', status: 'all' });
      expect(deps.relayCore!.readInbox).toHaveBeenCalledWith('relay.agent.a', {
        limit: undefined,
        status: 'all',
        ack: undefined,
      });
    });

    it('returns ENDPOINT_NOT_FOUND when endpoint missing', async () => {
      const deps = makeMockDeps({
        readInbox: vi.fn().mockImplementation(() => {
          throw new Error('Endpoint not found: x');
        }),
      });
      const handler = createRelayInboxHandler(deps);
      const result = await handler({ endpoint_subject: 'x' });
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
      const handler = createRelayRegisterEndpointHandler(makeMockDeps());
      const result = await handler({ subject: 'x' });
      expect(result.isError).toBe(true);
    });

    it('registers endpoint and returns info', async () => {
      const deps = makeMockDeps({});
      const handler = createRelayRegisterEndpointHandler(deps);
      const result = await handler({ subject: 'relay.agent.new', description: 'My bot' });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.endpoint.subject).toBe('relay.agent.new');
      expect(data.note).toBe('My bot');
    });

    it('returns REGISTRATION_FAILED on error', async () => {
      const deps = makeMockDeps({
        registerEndpoint: vi.fn().mockRejectedValue(new Error('Duplicate')),
      });
      const handler = createRelayRegisterEndpointHandler(deps);
      const result = await handler({ subject: 'relay.agent.dup' });
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
    expect(parsed.hint).toContain('Access panel');
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
    expect(identity.subject).toBe('relay.session.scratch');
    expect(identity.agentId).toBeUndefined();
  });

  it('uses the external principal when there is no session (undefined cwd)', () => {
    const identity = resolveSenderIdentity({} as McpToolDeps, undefined);
    expect(identity.subject).toBe(EXTERNAL_MCP_SENDER);
    expect(identity.agentId).toBeUndefined();
  });
});
