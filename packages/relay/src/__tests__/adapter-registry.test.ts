import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdapterRegistry } from '../adapter-registry.js';
import type { RelayAdapter, RelayPublisher, AdapterStatus } from '../types.js';

// --- Mock helpers ---

function createMockAdapter(overrides: Partial<RelayAdapter> = {}): RelayAdapter {
  const status: AdapterStatus = {
    state: 'connected',
    messageCount: { inbound: 0, outbound: 0 },
    errorCount: 0,
  };
  return {
    id: 'mock-adapter',
    subjectPrefix: 'relay.test.mock',
    displayName: 'Mock Adapter',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    deliver: vi.fn().mockResolvedValue({ success: true, durationMs: 0 }),
    getStatus: vi.fn().mockReturnValue(status),
    ...overrides,
  };
}

function createMockRelay(): RelayPublisher {
  return {
    publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
    onSignal: vi.fn().mockReturnValue(() => {}),
  };
}

function createMockEnvelope() {
  return {
    id: 'env-01',
    subject: 'relay.test.mock.event',
    from: 'relay.agent.sender',
    budget: { hopCount: 0, maxHops: 5, ancestorChain: [], ttl: Date.now() + 3600000, callBudgetRemaining: 10 },
    createdAt: new Date().toISOString(),
    payload: { text: 'hello' },
  };
}

// --- Tests ---

describe('AdapterRegistry', () => {
  let registry: AdapterRegistry;
  let mockRelay: RelayPublisher;

  beforeEach(() => {
    registry = new AdapterRegistry();
    mockRelay = createMockRelay();
    registry.setRelay(mockRelay);
  });

  // --- Registration ---

  it('register() starts adapter and adds it to the list', async () => {
    const adapter = createMockAdapter();
    await registry.register(adapter);

    expect(adapter.start).toHaveBeenCalledWith(mockRelay);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('mock-adapter')).toBe(adapter);
  });

  it('register() throws if relay has not been set', async () => {
    const freshRegistry = new AdapterRegistry(); // no setRelay() called
    const adapter = createMockAdapter();

    await expect(freshRegistry.register(adapter)).rejects.toThrow('relay not set');
  });

  it('unregister() stops and removes the adapter', async () => {
    const adapter = createMockAdapter();
    await registry.register(adapter);

    const result = await registry.unregister('mock-adapter');

    expect(result).toBe(true);
    expect(adapter.stop).toHaveBeenCalled();
    expect(registry.get('mock-adapter')).toBeUndefined();
    expect(registry.list()).toHaveLength(0);
  });

  it('unregister() returns false for an unknown adapter ID', async () => {
    const result = await registry.unregister('nonexistent');
    expect(result).toBe(false);
  });

  // --- Lookup ---

  it('get() returns the adapter by ID', async () => {
    const adapter = createMockAdapter({ id: 'my-adapter' });
    await registry.register(adapter);

    expect(registry.get('my-adapter')).toBe(adapter);
  });

  it('get() returns undefined for unknown ID', () => {
    expect(registry.get('unknown')).toBeUndefined();
  });

  it('getBySubject() matches by subject prefix', async () => {
    const adapter = createMockAdapter({ subjectPrefix: 'relay.human.telegram' });
    await registry.register(adapter);

    expect(registry.getBySubject('relay.human.telegram.12345')).toBe(adapter);
    expect(registry.getBySubject('relay.human.telegram.group.678')).toBe(adapter);
  });

  it('getBySubject() returns undefined when no adapter matches', async () => {
    const adapter = createMockAdapter({ subjectPrefix: 'relay.human.telegram' });
    await registry.register(adapter);

    expect(registry.getBySubject('relay.agent.backend')).toBeUndefined();
  });

  it('list() returns all registered adapters', async () => {
    const a1 = createMockAdapter({ id: 'adapter-1', subjectPrefix: 'relay.test.a1' });
    const a2 = createMockAdapter({ id: 'adapter-2', subjectPrefix: 'relay.test.a2' });
    await registry.register(a1);
    await registry.register(a2);

    expect(registry.list()).toHaveLength(2);
  });

  // --- Delivery ---

  it('deliver() routes to the correct adapter by subject prefix', async () => {
    const adapter = createMockAdapter({ subjectPrefix: 'relay.human.telegram' });
    await registry.register(adapter);

    const envelope = createMockEnvelope();
    const subject = 'relay.human.telegram.999';
    const delivered = await registry.deliver(subject, { ...envelope, subject });

    expect(delivered).toBe(true);
    expect(adapter.deliver).toHaveBeenCalledWith(subject, expect.objectContaining({ subject }), undefined);
  });

  it('deliver() returns false when no adapter matches', async () => {
    const envelope = createMockEnvelope();
    const result = await registry.deliver('relay.agent.backend', envelope);

    expect(result).toBe(false);
  });

  // --- Hot-reload ---

  it('hot-reload: new adapter starts before old adapter stops', async () => {
    const callOrder: string[] = [];

    const oldAdapter = createMockAdapter({ id: 'my-adapter', subjectPrefix: 'relay.test.v1' });
    vi.mocked(oldAdapter.stop).mockImplementation(async () => {
      callOrder.push('old-stop');
    });

    const newAdapter = createMockAdapter({ id: 'my-adapter', subjectPrefix: 'relay.test.v2' });
    vi.mocked(newAdapter.start).mockImplementation(async () => {
      callOrder.push('new-start');
    });

    await registry.register(oldAdapter);
    await registry.register(newAdapter);

    expect(callOrder).toEqual(['new-start', 'old-stop']);
    expect(registry.get('my-adapter')).toBe(newAdapter);
  });

  it('hot-reload: if new adapter start() throws, old adapter stays active', async () => {
    const oldAdapter = createMockAdapter({ id: 'my-adapter' });
    await registry.register(oldAdapter);

    const failingAdapter = createMockAdapter({ id: 'my-adapter' });
    vi.mocked(failingAdapter.start).mockRejectedValue(new Error('Connection refused'));

    await expect(registry.register(failingAdapter)).rejects.toThrow('Connection refused');

    // Old adapter should still be active
    expect(registry.get('my-adapter')).toBe(oldAdapter);
    expect(oldAdapter.stop).not.toHaveBeenCalled();
  });

  // --- Shutdown ---

  it('shutdown() calls stop() on all adapters via Promise.allSettled', async () => {
    const a1 = createMockAdapter({ id: 'adapter-1', subjectPrefix: 'relay.test.a1' });
    const a2 = createMockAdapter({ id: 'adapter-2', subjectPrefix: 'relay.test.a2' });
    await registry.register(a1);
    await registry.register(a2);

    await registry.shutdown();

    expect(a1.stop).toHaveBeenCalled();
    expect(a2.stop).toHaveBeenCalled();
  });

  it('shutdown() does not throw if one adapter stop() rejects', async () => {
    const a1 = createMockAdapter({ id: 'adapter-1', subjectPrefix: 'relay.test.a1' });
    const a2 = createMockAdapter({ id: 'adapter-2', subjectPrefix: 'relay.test.a2' });
    vi.mocked(a1.stop).mockRejectedValue(new Error('stop failed'));

    await registry.register(a1);
    await registry.register(a2);

    // Should not throw — Promise.allSettled isolates failures
    await expect(registry.shutdown()).resolves.toBeUndefined();
    expect(a2.stop).toHaveBeenCalled();
  });

  it('shutdown() clears the adapter map', async () => {
    const adapter = createMockAdapter();
    await registry.register(adapter);

    await registry.shutdown();

    expect(registry.list()).toHaveLength(0);
    expect(registry.get('mock-adapter')).toBeUndefined();
  });
});
