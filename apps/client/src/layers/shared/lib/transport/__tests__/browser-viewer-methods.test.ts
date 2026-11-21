// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserViewerMethods } from '../browser-viewer-methods';

const viewer = {
  viewerId: 'v'.repeat(43),
  nonce: 'n'.repeat(43),
  binding: { chatId: 'chat', profileId: 'profile', connectionId: 'connection', tabId: 'tab' },
};
const receipt = 'r'.repeat(43);
const metadata = { sequence: 1, generation: 1, width: 640, height: 480, byteLength: 3 };
afterEach(() => vi.unstubAllGlobals());

describe('browser viewer HTTP transport', () => {
  it('binds every request to the app client and keeps nonces out of URLs', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(viewer))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    const transport = createBrowserViewerMethods('/api', () => 'owner-window');
    expect(await transport.subscribeBrowserViewer('chat')).toEqual(viewer);
    await transport.closeBrowserViewer(viewer);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/browser-viewers',
      `/api/browser-viewers/${viewer.viewerId}`,
    ]);
    for (const [, init] of fetch.mock.calls) {
      expect(new Headers(init.headers).get('x-client-id')).toBe('owner-window');
      expect(init.cache).toBe('no-store');
      expect(init.credentials).toBe('include');
    }
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ nonce: viewer.nonce });
  });

  it('checks frame headers and bounded bytes before returning a paintable frame', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          'content-type': 'image/jpeg',
          'x-frame-receipt': receipt,
          'x-frame-metadata': JSON.stringify(metadata),
        },
      })
    );
    vi.stubGlobal('fetch', fetch);
    const transport = createBrowserViewerMethods('/api', () => 'owner-window');
    const result = await transport.nextBrowserViewerFrame(viewer, receipt);
    expect(result).toEqual({ ...metadata, receipt, bytes: new Uint8Array([1, 2, 3]) });
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ nonce: viewer.nonce, receipt });
  });

  it('treats an idle poll as liveness without decoding a frame', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    expect(
      await createBrowserViewerMethods('/api', () => 'owner-window').nextBrowserViewerFrame(viewer)
    ).toBeNull();
  });

  it.each([
    [{ ...metadata, width: 1281 }, new Uint8Array(3)],
    [{ ...metadata, byteLength: 2 * 1024 * 1024 + 1 }, new Uint8Array(3)],
    [metadata, new Uint8Array(4)],
    [metadata, new Uint8Array(2)],
  ])(
    'refuses inconsistent frame bounds without returning their bytes',
    async (description, bytes) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(bytes, {
            headers: {
              'content-type': 'image/jpeg',
              'x-frame-receipt': receipt,
              'x-frame-metadata': JSON.stringify(description),
            },
          })
        )
      );
      await expect(
        createBrowserViewerMethods('/api', () => 'owner-window').nextBrowserViewerFrame(viewer)
      ).rejects.toThrow('viewer_frame_invalid');
    }
  );
});
