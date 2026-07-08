/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMcpAppBridge, ADVERTISED_DISPLAY_MODES } from '../model/bridge';

/** A stand-in for the iframe whose contentWindow is the only trusted source. */
function makeIframe(): { iframe: HTMLIFrameElement; post: ReturnType<typeof vi.fn> } {
  const post = vi.fn();
  const contentWindow = { postMessage: post } as unknown as Window;
  const iframe = { contentWindow } as unknown as HTMLIFrameElement;
  return { iframe, post };
}

/** Dispatch a message as if it came from `source` at `origin`. */
function dispatchMessage(data: unknown, source: unknown, origin = 'null'): void {
  const event = new MessageEvent('message', { data });
  // jsdom does not let MessageEvent init set `source`, so define it directly.
  Object.defineProperty(event, 'source', { value: source, configurable: true });
  Object.defineProperty(event, 'origin', { value: origin, configurable: true });
  window.dispatchEvent(event);
}

const handlers = () => ({
  readResource: vi.fn().mockResolvedValue({ mimeType: 'text/html', text: '<p>hi</p>' }),
  openLink: vi.fn(),
  requestDisplayMode: vi.fn(),
});

describe('createMcpAppBridge', () => {
  let dispose: () => void;

  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => dispose?.());

  it('answers ui/initialize with the advertised display modes and host context', async () => {
    const { iframe, post } = makeIframe();
    dispose = createMcpAppBridge({
      iframe,
      expectedOrigin: 'null',
      hostContext: { hostName: 'DorkOS', theme: 'dark' },
      handlers: handlers(),
    });

    dispatchMessage({ jsonrpc: '2.0', id: 1, method: 'ui/initialize' }, iframe.contentWindow);
    await Promise.resolve();

    expect(post).toHaveBeenCalledTimes(1);
    const [reply] = post.mock.calls[0];
    expect(reply).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        availableDisplayModes: [...ADVERTISED_DISPLAY_MODES],
        hostContext: { hostName: 'DorkOS', theme: 'dark' },
      },
    });
  });

  it('proxies resources/read through the host handler', async () => {
    const { iframe, post } = makeIframe();
    const h = handlers();
    dispose = createMcpAppBridge({
      iframe,
      expectedOrigin: 'null',
      hostContext: { hostName: 'DorkOS', theme: 'light' },
      handlers: h,
    });

    dispatchMessage(
      { jsonrpc: '2.0', id: 7, method: 'resources/read', params: { uri: 'ui://a/b' } },
      iframe.contentWindow
    );
    await vi.waitFor(() => expect(post).toHaveBeenCalled());

    expect(h.readResource).toHaveBeenCalledWith('ui://a/b');
    expect(post.mock.calls[0][0]).toMatchObject({
      id: 7,
      result: { contents: [{ uri: 'ui://a/b', mimeType: 'text/html', text: '<p>hi</p>' }] },
    });
  });

  it('refuses tools/call with a not-permitted JSON-RPC error', async () => {
    const { iframe, post } = makeIframe();
    dispose = createMcpAppBridge({
      iframe,
      expectedOrigin: 'null',
      hostContext: { hostName: 'DorkOS', theme: 'light' },
      handlers: handlers(),
    });

    dispatchMessage(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'x' } },
      iframe.contentWindow
    );
    await Promise.resolve();

    expect(post.mock.calls[0][0]).toMatchObject({
      id: 3,
      error: { code: -32000, message: expect.stringContaining('not permitted') },
    });
  });

  it('returns method-not-found for unknown methods', async () => {
    const { iframe, post } = makeIframe();
    dispose = createMcpAppBridge({
      iframe,
      expectedOrigin: 'null',
      hostContext: { hostName: 'DorkOS', theme: 'light' },
      handlers: handlers(),
    });

    dispatchMessage({ jsonrpc: '2.0', id: 9, method: 'nope/whatever' }, iframe.contentWindow);
    await Promise.resolve();

    expect(post.mock.calls[0][0]).toMatchObject({ id: 9, error: { code: -32601 } });
  });

  it('forwards a fullscreen display-mode request to the host', async () => {
    const { iframe } = makeIframe();
    const h = handlers();
    dispose = createMcpAppBridge({
      iframe,
      expectedOrigin: 'null',
      hostContext: { hostName: 'DorkOS', theme: 'light' },
      handlers: h,
    });

    dispatchMessage(
      { jsonrpc: '2.0', id: 5, method: 'ui/request-display-mode', params: { mode: 'fullscreen' } },
      iframe.contentWindow
    );
    await Promise.resolve();

    expect(h.requestDisplayMode).toHaveBeenCalledWith('fullscreen');
  });

  it('routes ui/open-link to the host link handler', async () => {
    const { iframe } = makeIframe();
    const h = handlers();
    dispose = createMcpAppBridge({
      iframe,
      expectedOrigin: 'null',
      hostContext: { hostName: 'DorkOS', theme: 'light' },
      handlers: h,
    });

    dispatchMessage(
      { jsonrpc: '2.0', id: 6, method: 'ui/open-link', params: { url: 'https://example.com' } },
      iframe.contentWindow
    );
    await Promise.resolve();

    expect(h.openLink).toHaveBeenCalledWith('https://example.com');
  });

  it('ignores messages from a foreign source window', async () => {
    const { iframe, post } = makeIframe();
    dispose = createMcpAppBridge({
      iframe,
      expectedOrigin: 'null',
      hostContext: { hostName: 'DorkOS', theme: 'light' },
      handlers: handlers(),
    });

    // A different window object is not iframe.contentWindow → dropped.
    dispatchMessage({ jsonrpc: '2.0', id: 1, method: 'ui/initialize' }, { postMessage: vi.fn() });
    await Promise.resolve();

    expect(post).not.toHaveBeenCalled();
  });

  it('ignores messages whose origin is not the expected opaque origin', async () => {
    const { iframe, post } = makeIframe();
    dispose = createMcpAppBridge({
      iframe,
      expectedOrigin: 'null',
      hostContext: { hostName: 'DorkOS', theme: 'light' },
      handlers: handlers(),
    });

    dispatchMessage(
      { jsonrpc: '2.0', id: 1, method: 'ui/initialize' },
      iframe.contentWindow,
      'https://evil.example'
    );
    await Promise.resolve();

    expect(post).not.toHaveBeenCalled();
  });
});
