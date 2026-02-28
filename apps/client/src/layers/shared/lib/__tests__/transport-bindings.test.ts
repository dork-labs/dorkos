import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpTransport } from '../http-transport';
import { DirectTransport } from '../direct-transport';

const BASE_URL = 'http://localhost:4242/api';

const mockBinding = {
  id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  adapterId: 'telegram-main',
  agentId: 'agent-1',
  agentDir: '/home/user/agents/alpha',
  sessionStrategy: 'per-chat' as const,
  label: 'Main bot',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('HttpTransport — Relay Bindings', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('getBindings()', () => {
    it('calls GET /relay/bindings and returns the bindings array', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ bindings: [mockBinding] }), { status: 200 }),
      );

      const transport = new HttpTransport(BASE_URL);
      const result = await transport.getBindings();

      expect(fetch).toHaveBeenCalledWith(
        `${BASE_URL}/relay/bindings`,
        expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }),
      );
      expect(result).toEqual([mockBinding]);
    });

    it('returns an empty array when server returns empty bindings', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ bindings: [] }), { status: 200 }),
      );

      const transport = new HttpTransport(BASE_URL);
      const result = await transport.getBindings();

      expect(result).toEqual([]);
    });

    it('throws when the server responds with an error', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ error: 'Relay not enabled' }), { status: 503 }),
      );

      const transport = new HttpTransport(BASE_URL);
      await expect(transport.getBindings()).rejects.toThrow('Relay not enabled');
    });
  });

  describe('createBinding()', () => {
    it('calls POST /relay/bindings with the input body and returns the created binding', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ binding: mockBinding }), { status: 201 }),
      );

      const transport = new HttpTransport(BASE_URL);
      const input = {
        adapterId: 'telegram-main',
        agentId: 'agent-1',
        agentDir: '/home/user/agents/alpha',
        sessionStrategy: 'per-chat' as const,
        label: 'Main bot',
      };
      const result = await transport.createBinding(input);

      expect(fetch).toHaveBeenCalledWith(
        `${BASE_URL}/relay/bindings`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(input),
        }),
      );
      expect(result).toEqual(mockBinding);
    });

    it('throws when the server responds with a validation error', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ error: 'Validation failed' }), { status: 400 }),
      );

      const transport = new HttpTransport(BASE_URL);
      await expect(
        transport.createBinding({ adapterId: 'x', agentId: 'y', agentDir: '/z', sessionStrategy: 'per-chat', label: '' }),
      ).rejects.toThrow('Validation failed');
    });
  });

  describe('deleteBinding()', () => {
    it('calls DELETE /relay/bindings/:id', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const transport = new HttpTransport(BASE_URL);
      await transport.deleteBinding('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');

      expect(fetch).toHaveBeenCalledWith(
        `${BASE_URL}/relay/bindings/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11`,
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('URL-encodes the binding ID', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const transport = new HttpTransport(BASE_URL);
      await transport.deleteBinding('id with spaces');

      expect(fetch).toHaveBeenCalledWith(
        `${BASE_URL}/relay/bindings/id%20with%20spaces`,
        expect.anything(),
      );
    });

    it('throws when the server responds with 404', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ error: 'Binding not found' }), { status: 404 }),
      );

      const transport = new HttpTransport(BASE_URL);
      await expect(transport.deleteBinding('missing-id')).rejects.toThrow('Binding not found');
    });
  });
});

describe('DirectTransport — Relay Bindings', () => {
  it('getBindings() returns an empty array (not supported in embedded mode)', async () => {
    const transport = new DirectTransport({} as never);
    const result = await transport.getBindings();
    expect(result).toEqual([]);
  });

  it('createBinding() throws (not supported in embedded mode)', async () => {
    const transport = new DirectTransport({} as never);
    await expect(
      transport.createBinding({ adapterId: 'x', agentId: 'y', agentDir: '/z', sessionStrategy: 'per-chat', label: '' }),
    ).rejects.toThrow('Relay bindings are not supported in embedded mode');
  });

  it('deleteBinding() throws (not supported in embedded mode)', async () => {
    const transport = new DirectTransport({} as never);
    await expect(transport.deleteBinding('some-id')).rejects.toThrow(
      'Relay bindings are not supported in embedded mode',
    );
  });
});
