import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocCollabMethods } from '../doc-collab-methods';

/**
 * The live doc transport (DOR-2984): the socket URL names the doc, frames go
 * both ways as bytes, and a refusal's close code reaches the caller as its
 * HTTP status, which is how the editor knows to fall back to saving the file.
 */

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static last: FakeSocket | null = null;
  readonly url: string;
  readyState = 0;
  binaryType = 'blob';
  sent: unknown[] = [];
  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.last = this;
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }
  receive(bytes: Uint8Array) {
    this.dispatchEvent(new MessageEvent('message', { data: bytes.buffer }));
  }
  shut(code: number) {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent('close', { code }));
  }
}

const originalWebSocket = globalThis.WebSocket;
const originalFetch = globalThis.fetch;
const doc = { cwd: '/work/space', path: 'plans/launch.md' };

beforeEach(() => {
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
});
afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  globalThis.fetch = originalFetch;
});

describe('createDocCollabMethods().connectDocCollab', () => {
  it('opens the doc’s socket and carries bytes both ways', () => {
    const handlers = { onOpen: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() };
    const connection = createDocCollabMethods('/api').connectDocCollab(doc, handlers);
    const socket = FakeSocket.last!;
    const url = new URL(socket.url);
    expect(url.protocol).toBe('ws:');
    expect(url.pathname).toBe('/api/documents/live');
    expect(url.searchParams.get('cwd')).toBe(doc.cwd);
    expect(url.searchParams.get('path')).toBe(doc.path);
    expect(socket.binaryType).toBe('arraybuffer');

    connection.send(new Uint8Array([1]));
    expect(socket.sent).toEqual([]);
    socket.open();
    expect(handlers.onOpen).toHaveBeenCalledOnce();
    connection.send(new Uint8Array([2, 3]));
    expect(socket.sent).toEqual([new Uint8Array([2, 3])]);
    socket.receive(new Uint8Array([4]));
    expect(handlers.onMessage).toHaveBeenCalledWith(new Uint8Array([4]));
  });

  it('reports a refusal as its status, and a drop with none, once', () => {
    const refused = { onOpen: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() };
    createDocCollabMethods('/api').connectDocCollab(doc, refused);
    FakeSocket.last!.shut(4404);
    expect(refused.onClose).toHaveBeenCalledWith({ status: 404 });

    const dropped = { onOpen: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() };
    const connection = createDocCollabMethods('/api').connectDocCollab(doc, dropped);
    FakeSocket.last!.shut(1006);
    connection.close();
    expect(dropped.onClose).toHaveBeenCalledTimes(1);
    expect(dropped.onClose).toHaveBeenCalledWith({});
  });
});

describe('createDocCollabMethods() versions', () => {
  it('lists a doc’s versions and restores one', async () => {
    const fetchMock = vi.fn(async (url: unknown, _init?: RequestInit) =>
      Response.json(String(url).includes('restore') ? { ok: true, live: true } : { versions: [] })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const methods = createDocCollabMethods('/api');

    expect(await methods.listDocVersions(doc)).toEqual({ versions: [] });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      '/api/documents/versions?cwd=%2Fwork%2Fspace&path=plans%2Flaunch.md'
    );
    expect(await methods.restoreDocVersion(doc, 'v1')).toEqual({ ok: true, live: true });
    expect(fetchMock.mock.calls[1]![1]?.method).toBe('POST');
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({
      ...doc,
      versionId: 'v1',
    });
  });
});
