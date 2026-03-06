import { describe, it, expect, vi } from 'vitest';
import {
  createRelaySendHandler,
  createRelayInboxHandler,
  createRelayListEndpointsHandler,
  createRelayRegisterEndpointHandler,
  createRelayQueryHandler,
  type McpToolDeps,
} from '../mcp-tools/index.js';

function makeMockDeps(relayOverrides?: Record<string, unknown>): McpToolDeps {
  return {
    transcriptReader: {} as McpToolDeps['transcriptReader'],
    defaultCwd: '/test',
    relayCore: relayOverrides === undefined
      ? undefined
      : {
          publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 2 }),
          readInbox: vi.fn().mockReturnValue({ messages: [{ id: 'm1' }], nextCursor: undefined }),
          listEndpoints: vi.fn().mockReturnValue([{ subject: 'relay.agent.a', hash: 'h1', maildirPath: '/tmp/a', registeredAt: new Date().toISOString() }]),
          getDispatchInboxTtlMs: vi.fn().mockReturnValue(30 * 60 * 1000),
          registerEndpoint: vi.fn().mockResolvedValue({ subject: 'relay.agent.new', hash: 'h2' }),
          ...relayOverrides,
        } as unknown as McpToolDeps['relayCore'],
  };
}

describe('Relay MCP Tools', () => {
  describe('relay_send', () => {
    it('returns RELAY_DISABLED when relayCore is undefined', async () => {
      const handler = createRelaySendHandler(makeMockDeps());
      const result = await handler({ subject: 'x', payload: {}, from: 'a' });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'RELAY_DISABLED' });
    });

    it('publishes message and returns result', async () => {
      const deps = makeMockDeps({});
      const handler = createRelaySendHandler(deps);
      const result = await handler({ subject: 'relay.agent.x', payload: { hello: 1 }, from: 'relay.agent.sender' });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.messageId).toBe('msg-1');
      expect(data.deliveredTo).toBe(2);
      expect(deps.relayCore!.publish).toHaveBeenCalledWith('relay.agent.x', { hello: 1 }, {
        from: 'relay.agent.sender',
        replyTo: undefined,
        budget: undefined,
      });
    });

    it('returns ACCESS_DENIED on access error', async () => {
      const deps = makeMockDeps({
        publish: vi.fn().mockRejectedValue(new Error('Access denied: a -> b')),
      });
      const handler = createRelaySendHandler(deps);
      const result = await handler({ subject: 'b', payload: {}, from: 'a' });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'ACCESS_DENIED' });
    });

    it('returns INVALID_SUBJECT on invalid subject', async () => {
      const deps = makeMockDeps({
        publish: vi.fn().mockRejectedValue(new Error('Invalid subject: bad!')),
      });
      const handler = createRelaySendHandler(deps);
      const result = await handler({ subject: 'bad!', payload: {}, from: 'a' });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'INVALID_SUBJECT' });
    });
  });

  describe('relay_inbox', () => {
    it('returns RELAY_DISABLED when relayCore is undefined', async () => {
      const handler = createRelayInboxHandler(makeMockDeps());
      const result = await handler({ endpoint_subject: 'x' });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'RELAY_DISABLED' });
    });

    it('reads inbox and returns messages', async () => {
      const deps = makeMockDeps({});
      const handler = createRelayInboxHandler(deps);
      const result = await handler({ endpoint_subject: 'relay.agent.a', limit: 10 });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.messages).toHaveLength(1);
      expect(deps.relayCore!.readInbox).toHaveBeenCalledWith('relay.agent.a', { limit: 10, status: undefined });
    });

    it('returns ENDPOINT_NOT_FOUND when endpoint missing', async () => {
      const deps = makeMockDeps({
        readInbox: vi.fn().mockImplementation(() => { throw new Error('Endpoint not found: x'); }),
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
      { subject: 'relay.inbox.dispatch.abc', hash: 'h1', maildirPath: '/tmp/a', registeredAt: new Date().toISOString() },
      { subject: 'relay.inbox.query.def', hash: 'h2', maildirPath: '/tmp/b', registeredAt: new Date().toISOString() },
      { subject: 'relay.inbox.myagent', hash: 'h3', maildirPath: '/tmp/c', registeredAt: new Date().toISOString() },
      { subject: 'relay.agent.lifeOS', hash: 'h4', maildirPath: '/tmp/d', registeredAt: new Date().toISOString() },
      { subject: 'relay.human.console.x', hash: 'h5', maildirPath: '/tmp/e', registeredAt: new Date().toISOString() },
    ];
    const mockRelay = {
      listEndpoints: vi.fn().mockReturnValue(mockEndpoints),
      getDispatchInboxTtlMs: vi.fn().mockReturnValue(30 * 60 * 1000),
    };
    const handler = createRelayListEndpointsHandler({ relayCore: mockRelay as never } as McpToolDeps);
    const result = await handler();
    const parsed = JSON.parse(result.content[0].text);
    const bySubject = Object.fromEntries(parsed.endpoints.map((e: { subject: string; type: string }) => [e.subject, e.type]));
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
    const handler = createRelayListEndpointsHandler({ relayCore: mockRelay as never } as McpToolDeps);
    const result = await handler();
    const parsed = JSON.parse(result.content[0].text);
    const dispatch = parsed.endpoints.find((e: { subject: string }) => e.subject === 'relay.inbox.dispatch.abc');
    const query = parsed.endpoints.find((e: { subject: string }) => e.subject === 'relay.inbox.query.def');
    // Dispatch: expiresAt = registeredAt + 30min
    expect(dispatch.expiresAt).toBe(new Date(new Date(registeredAt).getTime() + ttlMs).toISOString());
    expect(query.expiresAt).toBeNull();
  });
});

describe('relay_query progress accumulation', () => {
  it('accumulates progress events and returns them in progress array', async () => {
    // Purpose: verify progress[] is populated when progress events precede agent_result.
    const progressPayload1 = { type: 'progress', step: 1, step_type: 'message', text: 'Analyzing...', done: false };
    const progressPayload2 = { type: 'progress', step: 2, step_type: 'tool_result', text: 'file contents', done: false };
    const finalPayload = { type: 'agent_result', text: 'Done.', done: true };

    const mockRelay = {
      registerEndpoint: vi.fn().mockResolvedValue({}),
      publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
      subscribe: vi.fn().mockImplementation((_subject: string, handler: (env: unknown) => void) => {
        // Simulate async delivery of progress events then final result
        setTimeout(() => handler({ payload: progressPayload1, from: 'relay.agent.b', id: 'e1' }), 5);
        setTimeout(() => handler({ payload: progressPayload2, from: 'relay.agent.b', id: 'e2' }), 10);
        setTimeout(() => handler({ payload: finalPayload, from: 'relay.agent.b', id: 'e3' }), 15);
        return vi.fn(); // unsub
      }),
      unregisterEndpoint: vi.fn().mockResolvedValue(true),
    };
    const handler = createRelayQueryHandler({ relayCore: mockRelay as never } as McpToolDeps);
    const result = await handler({
      to_subject: 'relay.agent.b',
      payload: { task: 'do work' },
      from: 'relay.agent.a',
      timeout_ms: 5000,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.progress).toHaveLength(2);
    expect(parsed.progress[0]).toMatchObject({ type: 'progress', step: 1 });
    expect(parsed.reply).toMatchObject({ type: 'agent_result', done: true });
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
    const handler = createRelayQueryHandler({ relayCore: mockRelay as never } as McpToolDeps);
    const result = await handler({
      to_subject: 'relay.agent.b',
      payload: { task: 'quick question' },
      from: 'relay.agent.a',
      timeout_ms: 5000,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.progress).toEqual([]);
    expect(parsed.reply).toEqual(plainPayload);
  });
});
