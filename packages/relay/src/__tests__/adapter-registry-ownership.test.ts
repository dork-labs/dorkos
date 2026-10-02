import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdapterRegistry } from '../adapter-registry.js';
import type { RelayAdapter } from '../types.js';
import { createMockRelay } from './fixtures.js';

function adapter(id: string, subjectPrefix: string | string[]): RelayAdapter {
  return {
    id,
    subjectPrefix,
    displayName: id,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    deliver: vi.fn(async () => ({ success: true, durationMs: 0 })),
    getStatus: () => ({
      state: 'connected',
      messageCount: { inbound: 0, outbound: 0 },
      errorCount: 0,
    }),
  };
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let registry: AdapterRegistry;
beforeEach(() => {
  registry = new AdapterRegistry();
  registry.setRelay(createMockRelay());
  registry.setLogger({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
});

describe('boundary routing and ownership', () => {
  it('matches exact and dot descendants without capturing lexical siblings', async () => {
    const x = adapter('x', 'relay.webhook.x');
    await registry.register(x);
    expect(registry.getBySubject('relay.webhook.x')).toBe(x);
    expect(registry.getBySubject('relay.webhook.x.child')).toBe(x);
    expect(registry.getBySubject('relay.webhook.x2')).toBeUndefined();
    expect(await registry.deliver('relay.webhook.x2', {} as never)).toBeNull();
    expect(x.deliver).not.toHaveBeenCalled();
  });
  it('trailing-dot claims match descendants, not the root or lexical sibling', async () => {
    const scoped = adapter('codex', 'relay.agent.codex.');
    await registry.register(scoped);
    expect(registry.getBySubject('relay.agent.codex')).toBeUndefined();
    expect(registry.getBySubject('relay.agent.codexx.session')).toBeUndefined();
    expect(registry.getBySubject('relay.agent.codex.session')).toBe(scoped);
  });
  it.each([false, true])('keeps runtime specialization with reverse order=%s', async (reverse) => {
    const broad = adapter('broad', 'relay.agent.');
    const scoped = adapter('codex', 'relay.agent.codex.');
    for (const a of reverse ? [scoped, broad] : [broad, scoped]) await registry.register(a);
    expect(registry.getBySubject('relay.agent.codex.session')).toBe(scoped);
    expect(registry.getBySubject('relay.agent.opencode.session')).toBe(broad);
  });
  it.each([
    'relay.webhook.x',
    'relay.webhook.x.',
    'relay.webhook.x.child',
    'relay.webhook.',
    'relay.',
  ])('rejects overlapping owner %s before start', async (prefix) => {
    const original = adapter('original', 'relay.webhook.x');
    await registry.register(original);
    const conflict = adapter('conflict', prefix);
    await expect(registry.register(conflict)).rejects.toThrow(/ownership/i);
    expect(conflict.start).not.toHaveBeenCalled();
    expect(registry.getBySubject('relay.webhook.x.child')).toBe(original);
  });
  it('allows independent webhook lexical siblings', async () => {
    const x = adapter('x', 'relay.webhook.x'),
      x2 = adapter('x2', 'relay.webhook.x2');
    await registry.register(x);
    await registry.register(x2);
    expect(registry.getBySubject('relay.webhook.x2')).toBe(x2);
  });
  it('rejects duplicate non-webhook claims without banning strict specialization', async () => {
    await registry.register(adapter('first', 'relay.agent.codex.'));
    const duplicate = adapter('duplicate', 'relay.agent.codex');
    await expect(registry.register(duplicate)).rejects.toThrow(/ownership/i);
    expect(duplicate.start).not.toHaveBeenCalled();
  });
  it('reserves pending ownership before awaiting startup', async () => {
    const start = deferred();
    const first = adapter('first', 'relay.webhook.x');
    vi.mocked(first.start).mockReturnValue(start.promise);
    const running = registry.register(first);
    const competing = adapter('second', 'relay.webhook.x.child');
    // Capture the result first so failed expectations never leak a pending start.
    const outcome = await registry.register(competing).then(
      () => null,
      (error) => error
    );
    start.resolve();
    await running;
    expect(outcome).toBeInstanceOf(Error);
    expect(competing.start).not.toHaveBeenCalled();
    expect(registry.getBySubject('relay.webhook.x.child')).toBe(first);
  });
  it('an abandoned start cannot overwrite a newer owner or release its pending claim', async () => {
    const original = adapter('same', 'relay.webhook.old');
    await registry.register(original);
    const staleClaim = registry.reserveOwnership('same', 'relay.webhook.stale');
    const stale = adapter('same', 'relay.webhook.stale'),
      gate = deferred();
    vi.mocked(stale.start).mockReturnValue(gate.promise);
    const staleStart = staleClaim.register(stale).catch((error) => error);
    staleClaim.release();
    const newClaim = registry.reserveOwnership('same', 'relay.webhook.new');
    staleClaim.release();
    const conflicting = adapter('conflict', 'relay.webhook.new.child');
    await expect(registry.register(conflicting)).rejects.toThrow(/ownership/i);
    const winner = adapter('same', 'relay.webhook.new');
    await newClaim.register(winner);
    newClaim.release();
    gate.resolve();
    expect(await staleStart).toBeInstanceOf(Error);
    expect(registry.get('same')).toBe(winner);
    expect(stale.stop).toHaveBeenCalledOnce();
    expect(winner.stop).not.toHaveBeenCalled();
    expect(original.stop).toHaveBeenCalledOnce();
  });
  it('keeps a replacement installed while an old unregister is awaiting stop', async () => {
    const old = adapter('same', 'relay.webhook.old');
    await registry.register(old);
    const stopped = deferred(),
      installed = deferred();
    vi.mocked(old.stop).mockReturnValue(stopped.promise);
    const removal = registry.unregister('same');
    const winner = adapter('same', 'relay.webhook.new');
    vi.mocked(winner.start).mockImplementation(async () => {
      installed.resolve();
    });
    const replacement = registry.register(winner);
    await installed.promise;
    // Let register's startup continuation install the winner before old stop resolves.
    await vi.waitFor(() => expect(registry.get('same')).toBe(winner));
    stopped.resolve();
    await Promise.all([removal, replacement]);
    expect(registry.get('same')).toBe(winner);
    expect(registry.getBySubject('relay.webhook.new.child')).toBe(winner);
    expect(registry.getBySubject('relay.webhook.old')).toBeUndefined();
    expect(old.stop).toHaveBeenCalledOnce();
    expect(winner.stop).not.toHaveBeenCalled();
  });
  it('can retry unregister after a failed stop of the same instance', async () => {
    const old = adapter('same', 'relay.webhook.old');
    await registry.register(old);
    vi.mocked(old.stop).mockRejectedValueOnce(new Error('stop refused'));
    await expect(registry.unregister('same')).rejects.toThrow('stop refused');
    expect(registry.get('same')).toBe(old);
    await expect(registry.unregister('same')).resolves.toBe(true);
    expect(old.stop).toHaveBeenCalledTimes(2);
    expect(registry.get('same')).toBeUndefined();
  });
  it('fences same-ID concurrent replacements and preserves the old owner on failure', async () => {
    const old = adapter('same', 'relay.webhook.old');
    await registry.register(old);
    const start = deferred();
    const next = adapter('same', 'relay.webhook.new');
    vi.mocked(next.start).mockReturnValue(start.promise);
    const running = registry.register(next).catch((error) => error);
    const stale = adapter('same', 'relay.webhook.other');
    const outcome = await registry.register(stale).then(
      () => null,
      (error) => error
    );
    start.reject(new Error('startup refused'));
    await running;
    expect(outcome).toBeInstanceOf(Error);
    expect(stale.start).not.toHaveBeenCalled();
    expect(registry.get('same')).toBe(old);
    expect(old.stop).not.toHaveBeenCalled();
    expect(next.stop).toHaveBeenCalledOnce();
    const winner = adapter('same', 'relay.webhook.new');
    await registry.register(winner);
    expect(registry.get('same')).toBe(winner);
    expect(old.stop).toHaveBeenCalledOnce();
  });
});
