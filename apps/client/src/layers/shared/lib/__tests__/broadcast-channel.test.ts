import { describe, it, expect, vi, afterEach } from 'vitest';
import { createChannel } from '../broadcast-channel';

describe('createChannel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns no-op channel when BroadcastChannel is unavailable', () => {
    // In Node/vitest, BroadcastChannel is not defined
    const originalBC = globalThis.BroadcastChannel;
    // @ts-expect-error -- deliberately removing for test
    delete globalThis.BroadcastChannel;

    const channel = createChannel('test');
    expect(() => channel.postMessage('hello')).not.toThrow();
    const unsub = channel.onMessage(() => {});
    expect(typeof unsub).toBe('function');
    expect(() => unsub()).not.toThrow();
    expect(() => channel.close()).not.toThrow();

    globalThis.BroadcastChannel = originalBC;
  });

  it('creates a working channel when BroadcastChannel is available', () => {
    const listeners: Array<(event: MessageEvent) => void> = [];
    const mockChannel = {
      postMessage: vi.fn(),
      addEventListener: vi.fn((_type: string, handler: (event: MessageEvent) => void) => {
        listeners.push(handler);
      }),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    };

    const originalBC = globalThis.BroadcastChannel;
    // Vitest 4 spies honor `new` semantics; the implementation must be constructible.
    globalThis.BroadcastChannel = vi.fn(function () {
      return mockChannel;
    }) as unknown as typeof BroadcastChannel;

    const channel = createChannel<string>('test-channel');

    // postMessage delegates to underlying channel
    channel.postMessage('hello');
    expect(mockChannel.postMessage).toHaveBeenCalledWith('hello');

    // onMessage subscribes
    const handler = vi.fn();
    const unsub = channel.onMessage(handler);
    expect(mockChannel.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));

    // Simulate message
    listeners[0]({ data: 'world' } as MessageEvent);
    expect(handler).toHaveBeenCalledWith('world');

    // Unsubscribe removes listener
    unsub();
    expect(mockChannel.removeEventListener).toHaveBeenCalledWith('message', expect.any(Function));

    // close delegates
    channel.close();
    expect(mockChannel.close).toHaveBeenCalled();

    globalThis.BroadcastChannel = originalBC;
  });
});
