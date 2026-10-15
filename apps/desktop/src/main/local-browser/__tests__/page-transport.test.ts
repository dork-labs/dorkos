import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { pageTransport } from '../page-transport';

function fixture() {
  const debuggerApi = Object.assign(new EventEmitter(), {
    attach: vi.fn(),
    detach: vi.fn(),
    isAttached: vi.fn(() => true),
    sendCommand: vi.fn(async () => ({ targetInfo: { targetId: 'owned-page', type: 'page' } })),
  });
  const contents = Object.assign(new EventEmitter(), {
    id: 42,
    debugger: debuggerApi,
    isDestroyed: () => false,
  }) as unknown as WebContents;
  const transport = pageTransport(contents);
  const received = vi.fn();
  transport.onmessage = received;
  const send = async (
    method: string,
    params = {},
    sessionId: string | undefined = 'dorkos-page-42'
  ) => {
    transport.send({ id: 1, method, params, sessionId });
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return { contents, debuggerApi, transport, received, send };
}

describe('page-only Electron debugger transport', () => {
  it('finishes hidden rendering setup before exposing the page target', async () => {
    const { debuggerApi, transport, received } = fixture();
    let release!: () => void;
    debuggerApi.sendCommand.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ targetInfo: { targetId: 'owned-page', type: 'page' } });
        })
    );
    transport.send({ id: 2, method: 'Target.setAutoAttach', params: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(received).not.toHaveBeenCalled();
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(debuggerApi.sendCommand.mock.calls.slice(0, 2)).toEqual([
      ['Emulation.setFocusEmulationEnabled', { enabled: false }],
      ['Emulation.setFocusEmulationEnabled', { enabled: true }],
    ]);
    expect(received).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'Target.attachedToTarget' })
    );
  });

  it('waits for navigation rendering setup before dispatching a later page command', async () => {
    const { contents, debuggerApi, transport, send } = fixture();
    transport.send({ id: 2, method: 'Target.setAutoAttach', params: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));
    debuggerApi.sendCommand.mockClear();
    let release!: () => void;
    debuggerApi.sendCommand.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ targetInfo: { targetId: 'owned-page', type: 'page' } });
        })
    );
    contents.emit('did-navigate');
    await send('Page.enable');
    expect(debuggerApi.sendCommand).toHaveBeenCalledTimes(1);
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(debuggerApi.sendCommand.mock.calls).toEqual([
      ['Emulation.setFocusEmulationEnabled', { enabled: false }],
      ['Emulation.setFocusEmulationEnabled', { enabled: true }],
      ['Page.enable', {}, undefined],
    ]);
  });

  it('stops a pending rendering reset when the guest closes', async () => {
    const { contents, debuggerApi, transport } = fixture();
    transport.send({ id: 2, method: 'Target.setAutoAttach', params: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));
    debuggerApi.sendCommand.mockClear();
    let release!: () => void;
    debuggerApi.sendCommand.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ targetInfo: { targetId: 'owned-page', type: 'page' } });
        })
    );
    contents.emit('did-navigate');
    await new Promise<void>((resolve) => setImmediate(resolve));
    transport.close();
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(debuggerApi.sendCommand).toHaveBeenCalledTimes(1);
    expect(contents.listenerCount('did-navigate')).toBe(0);
  });

  it('reports a failed rendering reset without exposing an unready target', async () => {
    const { debuggerApi, transport, received } = fixture();
    debuggerApi.sendCommand.mockRejectedValueOnce(new Error('Hidden compositor unavailable'));
    transport.send({ id: 2, method: 'Target.setAutoAttach', params: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(received).toHaveBeenCalledWith(
      expect.objectContaining({ error: { message: 'Hidden compositor unavailable' } })
    );
    expect(
      received.mock.calls.some(([message]) => message.method === 'Target.attachedToTarget')
    ).toBe(false);
  });

  it('serializes successive navigation resets before resuming page commands', async () => {
    const { contents, debuggerApi, transport, send } = fixture();
    transport.send({ id: 2, method: 'Target.setAutoAttach', params: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));
    debuggerApi.sendCommand.mockClear();
    contents.emit('did-navigate');
    contents.emit('did-navigate');
    await send('Page.enable');
    expect(debuggerApi.sendCommand.mock.calls).toEqual([
      ['Emulation.setFocusEmulationEnabled', { enabled: false }],
      ['Emulation.setFocusEmulationEnabled', { enabled: true }],
      ['Emulation.setFocusEmulationEnabled', { enabled: false }],
      ['Emulation.setFocusEmulationEnabled', { enabled: true }],
      ['Page.enable', {}, undefined],
    ]);
  });
  // A valid Playwright page command must reach the guest debugger without selecting the shell.
  it('dispatches the owned page session to the guest debugger', async () => {
    const { send, debuggerApi } = fixture();
    await send('Page.enable');
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith('Page.enable', {}, undefined);
  });

  // Session handles supplied by another browser must never address that browser through this bridge.
  it('rejects an unrelated session before dispatch', async () => {
    const { send, debuggerApi, received } = fixture();
    await send('Page.enable', {}, 'foreign-session');
    expect(debuggerApi.sendCommand).not.toHaveBeenCalled();
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(Object) }));
  });

  // Target commands can name siblings explicitly even when sent through an owned page session.
  it.each([
    ['Target.closeTarget', { targetId: 'foreign-page' }],
    ['Target.disposeBrowserContext', { browserContextId: 'foreign-context' }],
    ['Target.getTargetInfo', { targetId: 'foreign-page' }],
  ])('rejects %s addressing a foreign target', async (method, params) => {
    const { send, debuggerApi, received } = fixture();
    await send(method, params);
    expect(debuggerApi.sendCommand).not.toHaveBeenCalled();
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(Object) }));
  });

  // Closing twice must release listeners once and prevent any later command reaching Electron.
  it('closes idempotently and rejects subsequent commands', async () => {
    const { send, debuggerApi, transport } = fixture();
    transport.close();
    transport.close();
    await send('Page.enable');
    expect(debuggerApi.detach).toHaveBeenCalledTimes(1);
    expect(debuggerApi.listenerCount('message')).toBe(0);
    expect(debuggerApi.listenerCount('detach')).toBe(0);
    expect(debuggerApi.sendCommand).not.toHaveBeenCalled();
  });
});
