import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  constructOwnedBrowserEngine,
  type PrivateBrowserResourceOwner,
  type PrivateBrowserRetirementReceiver,
} from '../engine.js';
import { configuration, requestId } from './parent-fixture.js';
const acquisition = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../lifecycle/acquisition.js', () => ({
  acquireBrowser: acquisition.run,
}));

it('captures original private resource receiver once and joins its operation on the actual engine record', async () => {
  const home = await mkdtemp(join(tmpdir(), 'original-resource-birth-'));
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let receiver: PrivateBrowserRetirementReceiver | undefined;
  const hook = vi.fn(async (value: PrivateBrowserRetirementReceiver) => {
    expect(value).toBe(receiver);
    expect(value.isOrdinary()).toBe(true);
    expect(value.isAuthorityCurrent()).toBe(false);
    entered();
    await held;
  });
  let reads = 0;
  const resources: PrivateBrowserResourceOwner = {
    get onOriginalChild() {
      reads++;
      return hook;
    },
  };
  const owner = {
    resources,
    registerBirth: (value: PrivateBrowserRetirementReceiver) => {
      receiver = value;
    },
    refuseBirth: vi.fn(),
  };
  const engine = constructOwnedBrowserEngine({ ...configuration(), dataDir: home }, owner);
  Object.defineProperty(resources, 'onOriginalChild', {
    get: () => {
      throw new Error('LATE_REPLACEMENT');
    },
  });
  acquisition.run.mockImplementation(async (_config, _record, _cancel, _network, observe) => {
    await observe(
      Object.freeze({
        root: { pid: 123, birth: 'semantic-root' },
        supervisor: { pid: 124, birth: 'semantic-supervisor' },
        manager: { pid: 125, birth: 'semantic-manager' },
        identities: [{ pid: 123, birth: 'semantic-root' }],
        complete: true,
      })
    );
    throw new Error('STOP_BEFORE_SEMANTIC_READY');
  });
  const opening = engine.open({ kind: 'open', requestId, mode: 'ephemeral' });
  const outcome = opening.then(
    () => false,
    () => true
  );
  try {
    await entering;
    expect(reads).toBe(1);
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    expect(await outcome).toBe(true);
    expect(hook).toHaveBeenCalledOnce();
  } finally {
    release();
    await outcome;
    await engine.shutdown();
    await rm(home, { recursive: true, force: true });
    acquisition.run.mockReset();
  }
});
