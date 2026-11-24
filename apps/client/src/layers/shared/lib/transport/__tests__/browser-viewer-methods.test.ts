// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserViewerMethods } from '../browser-viewer-methods';

const viewer = {
  metadata: {
    revision: 0,
    navigationGeneration: 0,
    controlEpoch: 0,
    viewport: null,
    control: null,
    chooser: null,
  },
  viewerId: 'v'.repeat(43),
  nonce: 'n'.repeat(43),
  binding: { chatId: 'chat', profileId: 'profile', connectionId: 'connection', tabId: 'tab' },
};
const receipt = 'r'.repeat(43);
const metadata = {
  view: {
    ...viewer.metadata,
    viewport: { generation: 1, width: 640, height: 480, offsetTop: 0, scale: 1 },
  },
  sequence: 1,
  generation: 1,
  width: 640,
  height: 480,
  byteLength: 3,
};
afterEach(() => vi.unstubAllGlobals());

describe('browser viewer HTTP transport', () => {
  it('uses fixed person verbs, original viewer nonce and browser multipart boundaries', async () => {
    const fetch = vi
      .fn()
      .mockImplementation(async () => Response.json({ metadata: viewer.metadata }));
    vi.stubGlobal('fetch', fetch);
    const transport = createBrowserViewerMethods('/api', () => 'owner-window');
    const op = {
      nonce: 'wrong'.repeat(9),
      controllerId: 'c'.repeat(43),
      controlEpoch: 1,
      navigationGeneration: 1,
      viewportGeneration: 1,
      sequence: 1,
    };
    await transport.takeBrowserViewerControl(viewer);
    await transport.sendBrowserViewerInput(viewer, op, { kind: 'text', text: 'made-up input' });
    await transport.copyBrowserViewerSelection(viewer, op);
    await transport.pasteBrowserViewerText(viewer, op, 'made-up paste');
    await transport.uploadBrowserViewerFiles(viewer, op, 't'.repeat(43), [
      new File(['made-up bytes'], 'fixture.txt'),
    ]);
    await transport.cancelBrowserViewerFiles(viewer, op.controllerId, 1, 't'.repeat(43));
    await transport.endBrowserViewerControl(viewer, op.controllerId, 1, 'abandon');
    expect(fetch.mock.calls.map(([url]) => url.split('/').at(-1))).toEqual([
      'take-over',
      'input',
      'copy',
      'paste',
      'files',
      'files',
      'hand-back',
    ]);
    for (const [, init] of fetch.mock.calls) {
      const headers = new Headers(init.headers);
      expect(headers.get('x-client-id')).toBe('owner-window');
      expect(init.credentials).toBe('include');
      expect(init.cache).toBe('no-store');
      const body =
        typeof init.body === 'string'
          ? JSON.parse(init.body)
          : JSON.parse(headers.get('x-viewer-control')!);
      expect(body.nonce).toBe(viewer.nonce);
      if (init.body instanceof FormData) expect(headers.has('content-type')).toBe(false);
    }
  });
  it('rejects URL-shaped or unknown idle metadata without publishing it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 204,
          headers: {
            'x-viewer-metadata': JSON.stringify({
              ...viewer.metadata,
              url: 'https://private.example/made-up-token',
            }),
          },
        })
      )
    );
    await expect(
      createBrowserViewerMethods('/api', () => 'owner-window').nextBrowserViewerFrame(viewer)
    ).rejects.toThrow('viewer_frame_invalid');
    expect(JSON.stringify(viewer.metadata)).not.toContain('made-up-token');
  });

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
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 204,
          headers: { 'x-viewer-metadata': JSON.stringify(viewer.metadata) },
        })
      )
    );
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
