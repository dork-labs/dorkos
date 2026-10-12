import { describe, expect, it, vi } from 'vitest';
import { ComputerClientProvider } from '../provider.js';
const anchor = '/owned/anchor';
const endpoint = {
  opencodeUrl: 'http://127.0.0.1:9123',
  opencodePassword: 'private-guest-password',
  generation: 1,
};
function setup(fetch: typeof globalThis.fetch) {
  let enabled = true;
  let observed = { ...endpoint };
  const provider = new ComputerClientProvider({
    anchor,
    guestDirectory: '/home/agent/project',
    currentEnabled: () => enabled,
    ensureEndpoint: async () => observed,
    fetch,
  });
  return {
    provider,
    disable: () => {
      enabled = false;
    },
    rotate: () => {
      observed = { ...observed, generation: 2 };
    },
  };
}
describe('ComputerClientProvider', () => {
  it('uses only guest credentials and directory, maps sessions back to the anchor', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const req = input as Request;
      expect(req.headers.get('authorization')).toBe(
        `Basic ${Buffer.from('opencode:private-guest-password').toString('base64')}`
      );
      expect(req.headers.get('x-opencode-directory')).toBe('/home/agent/project');
      expect(new URL(req.url).searchParams.get('directory')).toBe('/home/agent/project');
      return Response.json([{ id: 'ses_one', directory: '/home/agent/project' }]);
    });
    const { provider } = setup(fetch);
    const client = await provider.getClient(anchor);
    const response = await client.session.list({ query: { directory: anchor } });
    expect(response.data).toEqual([{ id: 'ses_one', directory: anchor }]);
    expect(fetch).toHaveBeenCalledOnce();
    expect((await provider.prepareTurn()).mode).toBe('own');
  });
  it('refuses old clients after generation change and disabled work without fetching', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const { provider, rotate, disable } = setup(fetch);
    const old = await provider.getClient(anchor);
    rotate();
    await expect(old.session.list({ query: { directory: anchor } })).rejects.toThrow(
      'ENDPOINT_RETIRED'
    );
    const fresh = await provider.getClient(anchor);
    disable();
    expect(provider.peekClient()).toBeNull();
    await expect(fresh.session.list({ query: { directory: anchor } })).rejects.toThrow('DISABLED');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('maps its own authenticated global stream and rejects old generation events', async () => {
    let push!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        push = controller;
      },
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get('x-opencode-directory')).toBe('/home/agent/project');
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    });
    const { provider, rotate } = setup(fetch);
    const client = await provider.getClient(anchor);
    const { stream: events } = await client.global.event({ sseMaxRetryAttempts: 0 });
    const iterator = events[Symbol.asyncIterator]();
    const next = iterator.next();
    push.enqueue(
      new TextEncoder().encode(
        'data: {"directory":"/home/agent/project","payload":{"type":"server.connected"}}\n\n'
      )
    );
    expect((await next).value).toEqual(expect.objectContaining({ directory: anchor }));
    rotate();
    const retired = iterator.next();
    push.enqueue(
      new TextEncoder().encode(
        'data: {"directory":"/home/agent/project","payload":{"type":"server.connected"}}\n\n'
      )
    );
    await expect(retired).rejects.toThrow('ENDPOINT_RETIRED');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('rejects arbitrary network endpoints and foreign cwd before sidecar access', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = new ComputerClientProvider({
      anchor,
      guestDirectory: '/home/agent/project',
      currentEnabled: () => true,
      ensureEndpoint: async () => ({ ...endpoint, opencodeUrl: 'http://192.168.1.2:9123' }),
      fetch,
    });
    await expect(provider.getClient('/foreign')).rejects.toThrow('DIRECTORY_REFUSED');
    await expect(provider.getClient(anchor)).rejects.toThrow('ENDPOINT_REFUSED');
    expect(fetch).not.toHaveBeenCalled();
  });
});
