import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpTransport } from '../transport';

const BASE_URL = 'http://localhost:4242/api';

const mockBinding = {
  id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  adapterId: 'telegram-main',
  agentId: 'agent-1',
  sessionStrategy: 'per-chat' as const,
  label: 'Main bot',
  canInitiate: false,
  canReply: true,
  canReceive: true,
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
    it('reads every page of GET /relay/bindings and lists them oldest first', async () => {
      // The server pages newest first; the older route arrives on the second page.
      const second = { ...mockBinding, id: 'second', createdAt: '2020-01-01T00:00:00.000Z' };
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ bindings: [mockBinding], nextCursor: 'c1' }))
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ bindings: [second], nextCursor: null }))
        );

      const result = await new HttpTransport(BASE_URL).getBindings();

      const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
      expect(urls).toEqual([
        `${BASE_URL}/relay/bindings?limit=200`,
        `${BASE_URL}/relay/bindings?cursor=c1&limit=200`,
      ]);
      expect(result).toEqual([second, mockBinding]);
    });

    it('throws when the server responds with an error', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            title: 'That’s not available right now. Try again soon.',
            status: 503,
            code: 'temporarily_unavailable',
            detail: 'Relay not enabled',
          }),
          { status: 503 }
        )
      );

      const transport = new HttpTransport(BASE_URL);
      await expect(transport.getBindings()).rejects.toThrow('Relay not enabled');
    });
  });

  describe('createBinding()', () => {
    it('calls POST /relay/bindings with the input body and returns the created binding', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ binding: mockBinding }), { status: 201 })
      );

      const transport = new HttpTransport(BASE_URL);
      const input = {
        adapterId: 'telegram-main',
        agentId: 'agent-1',
        sessionStrategy: 'per-chat' as const,
        label: 'Main bot',
      };
      const result = await transport.createBinding(input);

      expect(fetch).toHaveBeenCalledWith(
        `${BASE_URL}/relay/bindings`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(input),
        })
      );
      expect(result).toEqual(mockBinding);
    });

    it('throws when the server responds with a validation error', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            title: 'The request didn’t pass its checks.',
            status: 400,
            code: 'invalid_request',
            detail: 'Validation failed',
          }),
          { status: 400 }
        )
      );

      const transport = new HttpTransport(BASE_URL);
      await expect(
        transport.createBinding({
          adapterId: 'x',
          agentId: 'y',
          sessionStrategy: 'per-chat',
          label: '',
        })
      ).rejects.toThrow('Validation failed');
    });
  });

  describe('deleteBinding()', () => {
    it('calls DELETE /relay/bindings/:id', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );

      const transport = new HttpTransport(BASE_URL);
      await transport.deleteBinding('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');

      expect(fetch).toHaveBeenCalledWith(
        `${BASE_URL}/relay/bindings/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11`,
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('URL-encodes the binding ID', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );

      const transport = new HttpTransport(BASE_URL);
      await transport.deleteBinding('id with spaces');

      expect(fetch).toHaveBeenCalledWith(
        `${BASE_URL}/relay/bindings/id%20with%20spaces`,
        expect.anything()
      );
    });

    it('throws when the server responds with 404', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            title: 'That doesn’t exist here.',
            status: 404,
            code: 'not_found',
            detail: 'Binding not found',
          }),
          { status: 404 }
        )
      );

      const transport = new HttpTransport(BASE_URL);
      await expect(transport.deleteBinding('missing-id')).rejects.toThrow('Binding not found');
    });
  });
});
