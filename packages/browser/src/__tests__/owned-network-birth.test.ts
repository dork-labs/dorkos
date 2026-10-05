import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { constructOwnedBrowserEngine, type PrivateBrowserRetirementReceiver } from '../engine.js';
import { configuration, requestId } from './parent-fixture.js';
const verify = vi.hoisted(() => vi.fn());
vi.mock('../runtime/public-library.js', () => ({ verifiedLibrary: verify }));
afterEach(() => verify.mockReset());
it('publishes exact verified runtime to the original prelaunch receiver without claiming ready custody', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'owned-network-birth-'));
  const config = {
    ...configuration(),
    dataDir,
    network: { kind: 'owned' as const, origin: 'about:blank' as const, policyRevision: 7 },
  };
  let original: PrivateBrowserRetirementReceiver | undefined;
  const bind = vi.fn(async (receiver: PrivateBrowserRetirementReceiver) => {
    expect(receiver).toBe(original);
    expect(receiver.verifiedRuntimeBinding()).toEqual({
      runtimeIdentity: createHash('sha256').update(JSON.stringify(config.runtime)).digest('hex'),
      policyRevision: 7,
    });
    expect(receiver.isAuthorityCurrent()).toBe(false);
    throw new Error('STOP_BEFORE_NATIVE_LAUNCH');
  });
  verify.mockResolvedValue({});
  const engine = constructOwnedBrowserEngine(config, {
    registerBirth(receiver) {
      original = receiver;
      expect(receiver.verifiedRuntimeBinding()).toBeNull();
    },
    refuseBirth() {},
    network: { bindBeforeLaunch: bind, activateReady: vi.fn() },
  });
  try {
    await expect(engine.open({ kind: 'open', requestId, mode: 'ephemeral' })).rejects.toThrow();
    expect(bind).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledOnce();
    expect(original!.isAuthorityCurrent()).toBe(false);
  } finally {
    await engine.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
});
it('never calls prelaunch binding or publishes runtime proof after failed genuine verification', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'owned-network-refusal-'));
  let original: PrivateBrowserRetirementReceiver | undefined;
  const bind = vi.fn();
  verify.mockRejectedValue(new Error('RUNTIME_REFUSED'));
  const engine = constructOwnedBrowserEngine(
    {
      ...configuration(),
      dataDir,
      network: { kind: 'owned', origin: 'about:blank', policyRevision: 7 },
    },
    {
      registerBirth(receiver) {
        original = receiver;
      },
      refuseBirth() {},
      network: { bindBeforeLaunch: bind, activateReady: vi.fn() },
    }
  );
  try {
    await expect(engine.open({ kind: 'open', requestId, mode: 'ephemeral' })).rejects.toThrow();
    expect(bind).not.toHaveBeenCalled();
    expect(original!.verifiedRuntimeBinding()).toBeNull();
    expect(original!.isAuthorityCurrent()).toBe(false);
  } finally {
    await engine.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
});
