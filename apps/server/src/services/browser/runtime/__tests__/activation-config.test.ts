import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { ConfigManager } from '../../../core/config-manager.js';
import { mintProductionBrowserEnablePermit } from '../activation/activation-permit.js';
it('actual original config store rolls back revoked post-write opt-in before publishing a change', async () => {
  const originals: { directory?: string; acquisition?: Promise<string> } = {};
  onTestFinished(async () => {
    if (originals.acquisition) originals.directory ??= await originals.acquisition;
    if (originals.directory) await rm(originals.directory, { recursive: true, force: true });
  });
  originals.acquisition = mkdtemp(join(tmpdir(), 'browser-activation-config-'));
  originals.directory = await originals.acquisition;
  const manager = new ConfigManager(originals.directory),
    changed = vi.fn();
  const unsubscribe = manager.onChange(changed);
  onTestFinished(unsubscribe);
  const store = (manager as unknown as { store: { set(key: string, value: unknown): void } }).store;
  const originalSet = store.set.bind(store);
  let current = true;
  const spy = vi.spyOn(store, 'set').mockImplementation((key, value) => {
    originalSet(key, value);
    if (key === 'browser.enabled' && value === true) current = false;
  });
  onTestFinished(() => spy.mockRestore());
  const permit = mintProductionBrowserEnablePermit(manager, () => current);
  expect(() => manager.enableOwnedBrowser(permit)).toThrow();
  expect(manager.get('browser').enabled).toBe(false);
  expect(changed).not.toHaveBeenCalled();
  expect(() => manager.setDot('browser.enabled', true)).toThrow();
});

it.each([undefined, false])(
  'retains exact original partial opt-in write failure %s despite independent rollback failure',
  async (reason) => {
    const originals: { directory?: string; acquisition?: Promise<string> } = {};
    onTestFinished(async () => {
      if (originals.acquisition) originals.directory ??= await originals.acquisition;
      if (originals.directory) await rm(originals.directory, { recursive: true, force: true });
    });
    originals.acquisition = mkdtemp(join(tmpdir(), 'browser-activation-config-'));
    originals.directory = await originals.acquisition;
    const manager = new ConfigManager(originals.directory),
      changed = vi.fn();
    const unsubscribe = manager.onChange(changed);
    onTestFinished(unsubscribe);
    const store = (manager as unknown as { store: { set(key: string, value: unknown): void } })
      .store;
    const originalSet = store.set.bind(store),
      secondary = new Error('ROLLBACK_SECONDARY');
    const spy = vi.spyOn(store, 'set').mockImplementation((key, value) => {
      originalSet(key, value);
      if (key === 'browser.enabled') {
        if (value === true) throw reason;
        throw secondary;
      }
    });
    onTestFinished(() => spy.mockRestore());
    const permit = mintProductionBrowserEnablePermit(manager, () => true);
    let failure: Readonly<{ value: unknown }> | undefined;
    try {
      manager.enableOwnedBrowser(permit);
    } catch (value) {
      failure = { value };
    }
    expect(failure).toBeDefined();
    expect(failure!.value).toBe(reason);
    expect(manager.get('browser').enabled).toBe(false);
    expect(changed).not.toHaveBeenCalled();
  }
);

it('an original current predicate cannot reenter the actual config consumer and produce a second store write', async () => {
  const originals: { directory?: string; acquisition?: Promise<string> } = {};
  onTestFinished(async () => {
    if (originals.acquisition) originals.directory ??= await originals.acquisition;
    if (originals.directory) await rm(originals.directory, { recursive: true, force: true });
  });
  originals.acquisition = mkdtemp(join(tmpdir(), 'browser-activation-config-'));
  originals.directory = await originals.acquisition;
  const manager = new ConfigManager(originals.directory),
    changed = vi.fn();
  const unsubscribe = manager.onChange(changed);
  onTestFinished(unsubscribe);
  const store = (manager as unknown as { store: { set(key: string, value: unknown): void } }).store;
  const originalSet = store.set.bind(store),
    attempts: unknown[] = [];
  const spy = vi.spyOn(store, 'set').mockImplementation((key, value) => {
    originalSet(key, value);
  });
  onTestFinished(() => spy.mockRestore());
  const permit = mintProductionBrowserEnablePermit(manager, () => {
    try {
      manager.enableOwnedBrowser(permit);
    } catch (reason) {
      attempts.push(reason);
    }
    return true;
  });
  manager.enableOwnedBrowser(permit);
  expect(attempts.length).toBeGreaterThan(0);
  expect(
    spy.mock.calls.filter(([key, value]) => key === 'browser.enabled' && value === true)
  ).toHaveLength(1);
  expect(changed).toHaveBeenCalledOnce();
  expect(manager.get('browser').enabled).toBe(true);
});
