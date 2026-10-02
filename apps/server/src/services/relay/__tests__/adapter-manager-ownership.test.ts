import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterRegistry, WebhookAdapter, type RelayAdapter } from '@dorkos/relay';
import { AdapterManager } from '../adapter-manager.js';

const saveGate = vi.hoisted(() => ({
  wait: undefined as Promise<void> | undefined,
  entered: undefined as (() => void) | undefined,
}));
vi.mock('../adapter-config.js', async (original) => {
  const actual = await original<typeof import('../adapter-config.js')>();
  return {
    ...actual,
    saveAdapterConfig: vi.fn(async (...args: Parameters<typeof actual.saveAdapterConfig>) => {
      saveGate.entered?.();
      await saveGate.wait;
      return actual.saveAdapterConfig(...args);
    }),
  };
});
vi.mock('chokidar', () => ({
  default: { watch: () => ({ on: vi.fn().mockReturnThis(), close: vi.fn(async () => {}) }) },
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createTaggedLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
const secret = 'ownership-fixture-secret16';
const config = (subject: string) => ({
  inbound: { subject, secret },
  outbound: { url: 'https://example.com/hook', secret },
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function plugin(id: string, prefix: string): RelayAdapter {
  return {
    id,
    displayName: id,
    subjectPrefix: prefix,
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
let directory: string | undefined;
let manager: AdapterManager | undefined;
let registry: AdapterRegistry;
async function boot(
  entries: unknown[] = [],
  resolveSecret = vi.fn(async () => ({ ok: true, secret })),
  awaitStarted = true
) {
  directory = await mkdtemp(join(tmpdir(), 'relay-ownership-'));
  const file = join(directory, 'adapters.json');
  await writeFile(
    file,
    JSON.stringify({
      adapters: [
        { id: 'claude-code', type: 'claude-code', enabled: false, builtin: true, config: {} },
        ...entries,
      ],
    })
  );
  registry = new AdapterRegistry();
  registry.setRelay({
    publish: vi.fn(async () => ({ messageId: 'fixture', deliveredTo: 1 })),
    subscribe: () => () => {},
    onSignal: () => () => {},
  });
  manager = new AdapterManager(registry, file, {
    traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() } as never,
    credentialStore: {
      put: vi.fn(async () => 'file:ownership-fixture-secret16'),
      get: vi.fn(async () => secret),
      delete: vi.fn(async () => {}),
    } as never,
    credentialProvider: { resolve: resolveSecret } as never,
  });
  await manager.initialize();
  if (awaitStarted) await manager.adaptersStarted();
  return { file, manager };
}
afterEach(async () => {
  saveGate.wait = undefined;
  saveGate.entered = undefined;
  await manager?.shutdown();
  manager = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('manager ownership before persistence', () => {
  it('applies an enabled webhook edit while initial credential resolution is pending', async () => {
    const building = deferred(),
      released = deferred();
    const resolveSecret = vi.fn(async () => ({ ok: true, secret }));
    resolveSecret.mockImplementationOnce(async () => {
      building.resolve();
      await released.promise;
      return { ok: true, secret };
    });
    const { manager, file } = await boot(
      [{ id: 'one', type: 'webhook', enabled: true, config: config('relay.webhook.old') }],
      resolveSecret,
      false
    );
    await building.promise;
    const saved = deferred();
    saveGate.entered = saved.resolve;
    const edit = manager.updateConfig('one', config('relay.webhook.new'));
    await saved.promise;
    released.resolve();
    await edit;
    await manager.adaptersStarted();
    expect(
      JSON.parse(await readFile(file, 'utf8')).adapters.find(
        (entry: { id: string }) => entry.id === 'one'
      )
    ).toMatchObject({ enabled: true, config: { inbound: { subject: 'relay.webhook.new' } } });
    const running = registry.get('one');
    expect(running).toBeInstanceOf(WebhookAdapter);
    expect(running?.getStatus().state).toBe('connected');
    expect(registry.getBySubject('relay.webhook.new.child')).toBe(running);
    expect(registry.getBySubject('relay.webhook.old')).toBeUndefined();
  });
  it('refuses disabled saved webhook overlap before any file mutation', async () => {
    const { file, manager } = await boot([
      { id: 'one', type: 'webhook', enabled: false, config: config('relay.webhook.x') },
    ]);
    const before = await readFile(file, 'utf8');
    await expect(
      manager.addAdapter('webhook', 'two', config('relay.webhook.x.child'), false)
    ).rejects.toThrow(/ownership/i);
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(manager.getAdapter('two')).toBeUndefined();
    await manager.addAdapter('webhook', 'two', config('relay.webhook.x2'), false);
    expect(manager.getAdapter('two')).toBeDefined();
  });
  it.each([false, true])(
    'refuses cross-type broad claim pending=%s before an add is persisted',
    async (pending) => {
      const { file, manager } = await boot();
      const before = await readFile(file, 'utf8');
      const blocker = plugin('plugin', 'relay.');
      const gate = deferred();
      if (pending) vi.mocked(blocker.start).mockReturnValue(gate.promise);
      const start = registry.register(blocker);
      if (!pending) await start;
      const failure = await manager.addAdapter('webhook', 'new', config('relay.webhook.x')).then(
        () => null,
        (error) => error
      );
      gate.resolve();
      await start;
      expect(failure).toBeInstanceOf(Error);
      expect(await readFile(file, 'utf8')).toBe(before);
      expect(manager.getAdapter('new')).toBeUndefined();
      expect(registry.get('new')).toBeUndefined();
    }
  );
  it('refuses conflicting edit before mutating or stopping the old real webhook', async () => {
    const { file, manager } = await boot([
      { id: 'one', type: 'webhook', enabled: true, config: config('relay.webhook.old') },
    ]);
    const old = registry.get('one');
    expect(old).toBeInstanceOf(WebhookAdapter);
    const stop = vi.spyOn(old!, 'stop');
    await registry.register(plugin('blocker', 'relay.webhook.new'));
    const before = await readFile(file, 'utf8');
    const stored = structuredClone(manager.getAdapter('one'));
    await expect(manager.updateConfig('one', config('relay.webhook.new'))).rejects.toThrow(
      /ownership/i
    );
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(manager.getAdapter('one')).toEqual(stored);
    expect(registry.get('one')).toBe(old);
    expect(stop).not.toHaveBeenCalled();
  });
  it('holds its claim across deferred save and rejects a competing registration', async () => {
    const { manager } = await boot();
    const saved = deferred(),
      entered = deferred();
    saveGate.wait = saved.promise;
    saveGate.entered = entered.resolve;
    const add = manager.addAdapter('webhook', 'new', config('relay.webhook.x'));
    await entered.promise;
    const competing = plugin('plugin', 'relay.webhook.');
    const failure = await registry.register(competing).then(
      () => null,
      (error) => error
    );
    saved.resolve();
    await add;
    expect(failure).toBeInstanceOf(Error);
    expect(competing.start).not.toHaveBeenCalled();
    expect(registry.get('new')).toBeInstanceOf(WebhookAdapter);
  });
  it('holds replacement ownership while its edit is being saved', async () => {
    const { manager } = await boot([
      { id: 'one', type: 'webhook', enabled: true, config: config('relay.webhook.old') },
    ]);
    const old = registry.get('one')!;
    const stop = vi.spyOn(old, 'stop');
    const saved = deferred(),
      entered = deferred();
    saveGate.wait = saved.promise;
    saveGate.entered = entered.resolve;
    const edit = manager.updateConfig('one', config('relay.webhook.new'));
    await entered.promise;
    const competing = plugin('plugin', 'relay.webhook.new.child');
    const failure = await registry.register(competing).then(
      () => null,
      (error) => error
    );
    expect(registry.get('one')).toBe(old);
    expect(stop).not.toHaveBeenCalled();
    saved.resolve();
    await edit;
    expect(failure).toBeInstanceOf(Error);
    expect(competing.start).not.toHaveBeenCalled();
    expect(registry.get('one')).toBeInstanceOf(WebhookAdapter);
    expect(registry.get('one')).not.toBe(old);
    expect(stop).toHaveBeenCalledOnce();
    expect(registry.getBySubject('relay.webhook.new.child')).toBe(registry.get('one'));
  });
  it('allows only one concurrent manager owner of a saved webhook address', async () => {
    const { manager } = await boot();
    const results = await Promise.allSettled([
      manager.addAdapter('webhook', 'one', config('relay.webhook.x'), false),
      manager.addAdapter('webhook', 'two', config('relay.webhook.x.child'), false),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(manager.getAdapter('two')).toBeUndefined();
  });
});
