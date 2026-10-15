/** @vitest-environment jsdom */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpAppBridge } from '../model/bridge';
import type { McpAppDocProjection, McpAppDocHost } from '../model/doc-extension';
const documentId = 'native-doc',
  generation = 'native-birth';
const event = {
  v: 1 as const,
  id: '33333333-3333-4333-8333-333333333333',
  type: 'task.changed',
  payload: { value: 1 },
};
const receipt = {
  receipt: { id: event.id, status: 'recorded' as const, docSeq: 1 },
  deliveries: [],
};
beforeEach(() => vi.stubGlobal('crypto', webcrypto));
const mounted: Array<() => void> = [];
afterEach(() => {
  for (const dispose of mounted.splice(0)) dispose();
  vi.unstubAllGlobals();
});
function setup(
  authorized = true,
  reused?: { iframe: HTMLIFrameElement; post: ReturnType<typeof vi.fn> }
) {
  const post = reused?.post ?? vi.fn();
  const frame = reused?.iframe.contentWindow ?? ({ postMessage: post } as unknown as Window);
  const iframe =
    reused?.iframe ??
    (Object.assign(new EventTarget(), {
      contentWindow: frame,
      contentDocument: null,
    }) as unknown as HTMLIFrameElement);
  const original = {
    id: event.id,
    bytes: JSON.stringify(event),
    current: () => authorized,
    submit: vi.fn(async () => receipt),
    inspect: vi.fn(async () => receipt),
  };
  const capture = vi.fn(() => original);
  const unsubscribe = vi.fn();
  let publish!: (view: McpAppDocProjection) => void;
  const host: McpAppDocHost = {
    documentId,
    generation,
    owner: {},
    current: () => authorized,
    captureOriginal: capture,
    subscribe: (receive) => {
      publish = receive;
      return unsubscribe;
    },
  };
  const readResource = vi.fn(async () => ({ mimeType: 'text/html', text: 'original' }));
  const dispose = createMcpAppBridge({
    iframe,
    expectedOrigin: 'null',
    hostContext: { hostName: 'DorkOS', theme: 'light' },
    docHost: host,
    handlers: {
      readResource,
      openLink: vi.fn(),
      requestDisplayMode: vi.fn(),
    },
  });
  mounted.push(dispose);
  const request = (method: string, params?: unknown, source: MessageEventSource = frame) => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source,
        origin: 'null',
        data: { jsonrpc: '2.0', id: 1, method, params },
      })
    );
  };
  let bridgeGeneration = '';
  const initialize = async () => {
    request('ui/initialize', { extensions: { 'dorkos/app': { version: 1 } } });
    iframe.dispatchEvent(new Event('load'));
    await vi.waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][0]).toMatchObject({
      result: {
        extensions: {
          'dorkos/app': {
            version: 1,
            documentId,
            generation,
            emit: true,
            events: true,
          },
        },
      },
    });
    bridgeGeneration = post.mock.calls[0][0].result.extensions['dorkos/app'].bridgeGeneration;
    expect(typeof bridgeGeneration).toBe('string');
    post.mockClear();
  };
  const emit = (params: unknown = { v: 1, documentId, generation, bridgeGeneration, event }) =>
    request('dorkos/app.emit', params);
  return {
    iframe,
    post,
    original,
    capture,
    unsubscribe,
    dispose,
    readResource,
    retireHost: () => {
      authorized = false;
    },
    request,
    initialize,
    emit,
    get bridgeGeneration() {
      return bridgeGeneration;
    },
    publish: (view: McpAppDocProjection) => publish(view),
  };
}
describe('original MCP document extension', () => {
  it('does not grant an unavailable host or an unsupported negotiated version', async () => {
    const own = setup(false);
    own.iframe.dispatchEvent(new Event('load'));
    own.request('ui/initialize', { extensions: { 'dorkos/app': { version: 1 } } });
    await vi.waitFor(() => expect(own.post).toHaveBeenCalledTimes(1));
    expect(own.post.mock.calls[0][0].result.extensions).toBeUndefined();
    own.post.mockClear();
    own.request('ui/initialize', { extensions: { 'dorkos/app': { version: 2 } } });
    await vi.waitFor(() => expect(own.post).toHaveBeenCalledTimes(1));
    expect(own.post.mock.calls[0][0].result.extensions).toBeUndefined();
    own.emit();
    await Promise.resolve();
    await Promise.resolve();
    expect(own.post).toHaveBeenCalledTimes(1);
    expect(own.capture).not.toHaveBeenCalled();
  });
  it('refuses unnegotiated, wrong-generation and reserved input without capture', async () => {
    const own = setup();
    own.emit();
    await vi.waitFor(() => expect(own.post).toHaveBeenCalled());
    expect(own.capture).not.toHaveBeenCalled();
    own.post.mockClear();
    await own.initialize();
    own.emit({
      v: 1,
      documentId,
      generation: 'stale',
      bridgeGeneration: own.bridgeGeneration,
      event,
    });
    own.emit({
      v: 1,
      documentId,
      generation,
      bridgeGeneration: own.bridgeGeneration,
      event: { ...event, type: 'doc.saved' },
    });
    await vi.waitFor(() => expect(own.post).toHaveBeenCalledTimes(2));
    expect(own.capture).not.toHaveBeenCalled();
  });
  it('records log-only and deduplicates exact event identity without another original submit', async () => {
    const own = setup();
    await own.initialize();
    own.emit();
    await vi.waitFor(() => expect(own.post).toHaveBeenCalledTimes(1));
    own.emit();
    await vi.waitFor(() => expect(own.post).toHaveBeenCalledTimes(2));
    expect(own.capture).toHaveBeenCalledTimes(2);
    expect(own.original.inspect).toHaveBeenCalledTimes(1);
    expect(own.original.submit).toHaveBeenCalledTimes(1);
    own.emit({
      v: 1,
      documentId,
      generation,
      bridgeGeneration: own.bridgeGeneration,
      event: { ...event, payload: { value: 2 } },
    });
    await vi.waitFor(() => expect(own.post).toHaveBeenCalledTimes(3));
    expect(own.post.mock.calls[2][0]).toMatchObject({ error: { code: -32000 } });
  });
  it('promptly refuses held same-original RPC retries without retaining duplicate waiters or another native submit', async () => {
    const own = setup();
    let finish!: (value: typeof receipt) => void;
    own.original.submit.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await own.initialize();
    own.emit();
    await vi.waitFor(() => expect(own.original.submit).toHaveBeenCalledTimes(1));
    for (let index = 0; index < 150; index++) own.emit();
    await vi.waitFor(() => expect(own.post).toHaveBeenCalledTimes(150));
    expect(own.post.mock.calls.every((call) => call[0].error?.code === -32000)).toBe(true);
    expect(own.capture).toHaveBeenCalledTimes(1);
    expect(own.original.submit).toHaveBeenCalledTimes(1);
    expect(own.original.inspect).not.toHaveBeenCalled();
    finish(receipt);
    await vi.waitFor(() => expect(own.post).toHaveBeenCalledTimes(151));
    expect(own.post.mock.calls[150][0]).toMatchObject({ result: receipt });
    own.emit();
    await vi.waitFor(() => expect(own.post).toHaveBeenCalledTimes(152));
    expect(own.original.submit).toHaveBeenCalledTimes(1);
    expect(own.original.inspect).toHaveBeenCalledTimes(1);
  });
  it('inspects the same original operation after a lost response, never resubmits it', async () => {
    const own = setup();
    own.original.submit.mockRejectedValueOnce(undefined);
    await own.initialize();
    own.emit();
    await vi.waitFor(() => expect(own.post).toHaveBeenCalledTimes(1));
    own.emit();
    await vi.waitFor(() => expect(own.post).toHaveBeenCalledTimes(2));
    expect(own.original.submit).toHaveBeenCalledTimes(1);
    expect(own.original.inspect).toHaveBeenCalledTimes(1);
    expect(own.post.mock.calls[1][0]).toMatchObject({ result: receipt });
  });
  it('retains source-window enforcement and tools/call refusal', async () => {
    const own = setup();
    await own.initialize();
    own.request(
      'dorkos/app.emit',
      { v: 1, documentId, generation, bridgeGeneration: own.bridgeGeneration, event },
      window
    );
    own.request('tools/call', { name: 'ui.send_doc_event' });
    await vi.waitFor(() => expect(own.post).toHaveBeenCalledTimes(1));
    expect(own.capture).not.toHaveBeenCalled();
    expect(own.post.mock.calls[0][0]).toMatchObject({ error: { code: -32000 } });
  });
  it('sends only reducer state and receipt DATA, then suppresses retired publications', async () => {
    const own = setup();
    await own.initialize();
    const view = {
      events: [],
      state: { form: { value: 'retained' } },
      stateRev: 1,
      docSeq: 1,
      resetRequired: false,
      receipts: [receipt],
    };
    own.publish(view);
    own.publish(view);
    expect(own.post).toHaveBeenCalledTimes(2);
    expect(own.post.mock.calls[0][0]).toEqual({
      jsonrpc: '2.0',
      method: 'dorkos/app.event',
      params: {
        v: 1,
        documentId,
        generation,
        bridgeGeneration: own.bridgeGeneration,
        kind: 'state',
        state: view.state,
        stateRev: 1,
        docSeq: 1,
        resetRequired: false,
      },
    });
    own.dispose();
    own.publish({ ...view, stateRev: 2 });
    expect(own.post).toHaveBeenCalledTimes(2);
  });
  it('preserves legitimate separate state above the event envelope bound and retires oversized state', async () => {
    const own = setup();
    await own.initialize();
    const view = {
      events: [],
      state: { text: 'x'.repeat(20 * 1024) },
      stateRev: 1,
      docSeq: 1,
      resetRequired: false,
      receipts: [],
    };
    own.publish(view);
    expect(own.post).toHaveBeenCalledTimes(1);
    expect(own.post.mock.calls[0][0].params).toMatchObject({ kind: 'state', state: view.state });
    expect(own.unsubscribe).not.toHaveBeenCalled();
    own.publish({ ...view, state: { text: 'x'.repeat(256 * 1024) }, stateRev: 2 });
    expect(own.post).toHaveBeenCalledTimes(1);
    expect(own.unsubscribe).toHaveBeenCalledTimes(1);
    own.publish({ ...view, stateRev: 3 });
    expect(own.post).toHaveBeenCalledTimes(1);
  });
  it('refuses a queued old emit after same-WindowProxy same-document bridge replacement', async () => {
    const old = setup();
    await old.initialize();
    const previous = old.bridgeGeneration;
    old.dispose();
    old.post.mockClear();
    const next = setup(true, { iframe: old.iframe, post: old.post });
    await next.initialize();
    expect(next.bridgeGeneration).not.toBe(previous);
    next.emit({ v: 1, documentId, generation, bridgeGeneration: previous, event });
    await vi.waitFor(() => expect(next.post).toHaveBeenCalledTimes(1));
    expect(next.post.mock.calls[0][0]).toMatchObject({ error: { code: -32000 } });
    expect(next.capture).not.toHaveBeenCalled();
  });
  it('does not negotiate from an actual readable initial blank or consume the subsequent opaque resource load', async () => {
    const own = setup();
    const blank = document.createElement('iframe');
    document.body.appendChild(blank);
    mounted.push(() => blank.remove());
    expect(blank.contentDocument?.URL).toBe('about:blank');
    Object.defineProperty(own.iframe, 'contentDocument', {
      value: blank.contentDocument,
      configurable: true,
    });
    own.request('ui/initialize', { extensions: { 'dorkos/app': { version: 1 } } });
    own.iframe.dispatchEvent(new Event('load'));
    await Promise.resolve();
    await Promise.resolve();
    expect(own.post).not.toHaveBeenCalled();
    Object.defineProperty(own.iframe, 'contentDocument', { value: null, configurable: true });
    own.iframe.dispatchEvent(new Event('load'));
    await vi.waitFor(() => expect(own.post).toHaveBeenCalledTimes(1));
    expect(own.post.mock.calls[0][0].result.extensions['dorkos/app']).toMatchObject({
      emit: true,
      events: true,
    });
  });
  it('does not advertise positive permission after initialization retires in the await continuation', async () => {
    const own = setup();
    own.request('ui/initialize', { extensions: { 'dorkos/app': { version: 1 } } });
    own.iframe.dispatchEvent(new Event('load'));
    // First microtask resolves the extension's exact load/current gate; the bridge continuation
    // is queued next, and must repeat currentness after this intervening owner retirement.
    await Promise.resolve();
    own.retireHost();
    await Promise.resolve();
    await Promise.resolve();
    expect(own.post).not.toHaveBeenCalled();
  });
  it('preserves base render-only initialization and resource reads after extension navigation retirement', async () => {
    const own = setup();
    await own.initialize();
    own.iframe.dispatchEvent(new Event('load'));
    own.request('ui/initialize', { extensions: { 'dorkos/app': { version: 1 } } });
    await vi.waitFor(() => expect(own.post).toHaveBeenCalledTimes(1));
    expect(own.post.mock.calls[0][0].result.extensions).toBeUndefined();
    own.request('resources/read', { uri: 'ui://original' });
    await vi.waitFor(() => expect(own.post).toHaveBeenCalledTimes(2));
    expect(own.post.mock.calls[1][0]).toMatchObject({
      result: { contents: [{ text: 'original' }] },
    });
    own.emit();
    await vi.waitFor(() => expect(own.post).toHaveBeenCalledTimes(3));
    expect(own.capture).not.toHaveBeenCalled();
  });
  it('suppresses awaited resources after original host retirement', async () => {
    const own = setup();
    await own.initialize();
    let finish!: (value: { mimeType: string; text: string }) => void;
    own.readResource.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    own.request('resources/read', { uri: 'ui://original' });
    await vi.waitFor(() => expect(own.readResource).toHaveBeenCalledTimes(1));
    own.retireHost();
    finish({ mimeType: 'text/html', text: 'retired' });
    await Promise.resolve();
    await Promise.resolve();
    expect(own.post).not.toHaveBeenCalled();
  });
  it('retires on actual navigation and suppresses late receipt output', async () => {
    const own = setup();
    let finish!: (value: typeof receipt) => void;
    own.original.submit.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await own.initialize();
    own.emit();
    await vi.waitFor(() => expect(own.original.submit).toHaveBeenCalled());
    own.iframe.dispatchEvent(new Event('load'));
    finish(receipt);
    await Promise.resolve();
    await Promise.resolve();
    expect(own.post).not.toHaveBeenCalled();
    expect(own.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
