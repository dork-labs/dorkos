import { describe, it, expect, vi } from 'vitest';
import {
  createBindingListHandler,
  createBindingCreateHandler,
  createBindingDeleteHandler,
  type McpToolDeps,
} from '../mcp-tool-server.js';

/** Create a mock BindingStore with default stubs. */
function makeMockBindingStore(overrides?: Record<string, unknown>) {
  return {
    getAll: vi.fn().mockReturnValue([
      {
        id: 'b-1',
        adapterId: 'tg-main',
        agentId: 'agent-1',
        agentDir: '/projects/bot',
        sessionStrategy: 'per-chat',
        label: 'Main Bot',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]),
    create: vi.fn().mockResolvedValue({
      id: 'b-new',
      adapterId: 'tg-main',
      agentId: 'agent-2',
      agentDir: '/projects/new-bot',
      sessionStrategy: 'per-chat',
      label: '',
      createdAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    }),
    delete: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function makeMockDeps(
  bindingStore?: ReturnType<typeof makeMockBindingStore> | undefined,
): McpToolDeps {
  return {
    transcriptReader: {} as McpToolDeps['transcriptReader'],
    defaultCwd: '/test',
    bindingStore: bindingStore as unknown as McpToolDeps['bindingStore'],
  };
}

describe('Binding MCP Tools', () => {
  describe('binding_list', () => {
    it('returns BINDINGS_DISABLED when bindingStore is undefined', async () => {
      const handler = createBindingListHandler(makeMockDeps());
      const result = await handler();
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'BINDINGS_DISABLED' });
    });

    it('lists bindings with count', async () => {
      const store = makeMockBindingStore();
      const handler = createBindingListHandler(makeMockDeps(store));
      const result = await handler();
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(1);
      expect(data.bindings[0].id).toBe('b-1');
      expect(data.bindings[0].adapterId).toBe('tg-main');
      expect(store.getAll).toHaveBeenCalledOnce();
    });

    it('returns empty list when no bindings exist', async () => {
      const store = makeMockBindingStore({ getAll: vi.fn().mockReturnValue([]) });
      const handler = createBindingListHandler(makeMockDeps(store));
      const result = await handler();
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(0);
      expect(data.bindings).toEqual([]);
    });
  });

  describe('binding_create', () => {
    it('returns BINDINGS_DISABLED when bindingStore is undefined', async () => {
      const handler = createBindingCreateHandler(makeMockDeps());
      const result = await handler({ adapterId: 'x', agentId: 'y', agentDir: '/z' });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'BINDINGS_DISABLED' });
    });

    it('creates binding successfully', async () => {
      const store = makeMockBindingStore();
      const handler = createBindingCreateHandler(makeMockDeps(store));
      const result = await handler({
        adapterId: 'tg-main',
        agentId: 'agent-2',
        agentDir: '/projects/new-bot',
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.binding.id).toBe('b-new');
      expect(data.binding.adapterId).toBe('tg-main');
      expect(store.create).toHaveBeenCalledWith(
        expect.objectContaining({
          adapterId: 'tg-main',
          agentId: 'agent-2',
          agentDir: '/projects/new-bot',
          sessionStrategy: 'per-chat',
          label: '',
        }),
      );
    });

    it('passes optional fields to create', async () => {
      const store = makeMockBindingStore();
      const handler = createBindingCreateHandler(makeMockDeps(store));
      await handler({
        adapterId: 'tg-main',
        agentId: 'agent-2',
        agentDir: '/projects/new-bot',
        sessionStrategy: 'stateless',
        chatId: 'chat-123',
        channelType: 'dm',
        label: 'My Binding',
      });
      expect(store.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionStrategy: 'stateless',
          chatId: 'chat-123',
          channelType: 'dm',
          label: 'My Binding',
        }),
      );
    });

    it('returns BINDING_CREATE_FAILED on error', async () => {
      const store = makeMockBindingStore({
        create: vi.fn().mockRejectedValue(new Error('Validation failed')),
      });
      const handler = createBindingCreateHandler(makeMockDeps(store));
      const result = await handler({ adapterId: 'x', agentId: 'y', agentDir: '/z' });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.code).toBe('BINDING_CREATE_FAILED');
      expect(data.error).toContain('Validation failed');
    });
  });

  describe('binding_delete', () => {
    it('returns BINDINGS_DISABLED when bindingStore is undefined', async () => {
      const handler = createBindingDeleteHandler(makeMockDeps());
      const result = await handler({ id: 'b-1' });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'BINDINGS_DISABLED' });
    });

    it('returns Deleted on success', async () => {
      const store = makeMockBindingStore();
      const handler = createBindingDeleteHandler(makeMockDeps(store));
      const result = await handler({ id: 'b-1' });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.result).toBe('Deleted');
      expect(data.id).toBe('b-1');
      expect(store.delete).toHaveBeenCalledWith('b-1');
    });

    it('returns Not found when id does not exist', async () => {
      const store = makeMockBindingStore({
        delete: vi.fn().mockResolvedValue(false),
      });
      const handler = createBindingDeleteHandler(makeMockDeps(store));
      const result = await handler({ id: 'nonexistent' });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.result).toBe('Not found');
      expect(data.id).toBe('nonexistent');
    });
  });
});
