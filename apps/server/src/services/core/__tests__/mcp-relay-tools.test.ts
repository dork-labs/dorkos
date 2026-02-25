import { describe, it, expect, vi } from 'vitest';
import {
  createRelaySendHandler,
  createRelayInboxHandler,
  createRelayListEndpointsHandler,
  createRelayRegisterEndpointHandler,
  type McpToolDeps,
} from '../mcp-tool-server.js';

function makeMockDeps(relayOverrides?: Record<string, unknown>): McpToolDeps {
  return {
    transcriptReader: {} as McpToolDeps['transcriptReader'],
    defaultCwd: '/test',
    relayCore: relayOverrides === undefined
      ? undefined
      : {
          publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 2 }),
          readInbox: vi.fn().mockReturnValue({ messages: [{ id: 'm1' }], nextCursor: undefined }),
          listEndpoints: vi.fn().mockReturnValue([{ subject: 'relay.agent.a', hash: 'h1' }]),
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
