/**
 * The once-per-install open mesh (DOR-2739, spec `trusted-by-default-flip`
 * §5.3), driven through a real `MeshCore` and its rule store, so "open" means
 * what the Topology switch reads, not a mock's call log. Only Relay's access
 * table is stood in for, in memory.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MeshCore } from '@dorkos/mesh';
import type { RelayCore } from '@dorkos/relay';
import { createTestDb } from '@dorkos/test-utils/db';
import { USER_CONFIG_DEFAULTS, type UserConfig } from '@dorkos/shared/config-schema';
import { noopLogger } from '@dorkos/shared/logger';
import { applyTrustedStores, openMeshStep, type TrustedStoreStep } from '../seed-open-mesh.js';

const NOW = new Date('2026-10-07T12:00:00.000Z');

/** An in-memory stand-in for Relay's access table: what was allowed, by pattern. */
function fakeRelay() {
  const rules = new Map<string, { action: string; priority: number }>();
  const relay = {
    addAccessRule: vi.fn((rule: { from: string; to: string; action: string; priority: number }) => {
      rules.set(`${rule.from} -> ${rule.to}`, rule);
    }),
    removeAccessRule: vi.fn((from: string, to: string) => {
      rules.delete(`${from} -> ${to}`);
    }),
    listAccessRules: vi.fn(() =>
      [...rules.entries()].map(([key, rule]) => {
        const [from, to] = key.split(' -> ');
        return { from, to, ...rule };
      })
    ),
  };
  return { relay: relay as unknown as RelayCore, rules };
}

/** The `permissions` section, held in memory the way the config store holds it. */
function memoryConfig(initial: UserConfig['permissions'] = USER_CONFIG_DEFAULTS.permissions) {
  let section = structuredClone(initial);
  return {
    get: () => section,
    set: vi.fn((next: UserConfig['permissions']) => {
      section = structuredClone(next);
    }),
  };
}

/** What the Topology switch reads: whether the mesh-wide `* → *` rule is stored. */
function isOpen(mesh: MeshCore): boolean {
  return mesh.getTopology('*').openMesh;
}

describe('applyTrustedStores with the open-mesh step', () => {
  let mesh: MeshCore;
  let relayRules: Map<string, unknown>;

  beforeEach(() => {
    const { relay, rules } = fakeRelay();
    relayRules = rules;
    mesh = new MeshCore({ db: createTestDb(), relayCore: relay, logger: noopLogger });
  });

  it('opens the mesh on first boot and stamps the install', async () => {
    const config = memoryConfig();
    expect(isOpen(mesh)).toBe(false);

    const stamped = await applyTrustedStores({
      config,
      steps: [openMeshStep(mesh, true)],
      logger: noopLogger,
      now: () => NOW,
    });

    expect(stamped).toBe(true);
    expect(isOpen(mesh)).toBe(true);
    expect(relayRules.has('relay.agent.> -> relay.agent.>')).toBe(true);
    expect(config.get().trustedStoresAppliedAt).toBe(NOW.toISOString());
  });

  it('leaves the mesh closed on a later boot, after a person turned it off', async () => {
    const config = memoryConfig();
    await applyTrustedStores({ config, steps: [openMeshStep(mesh, true)], logger: noopLogger });
    mesh.denyCrossNamespace('*', '*');
    expect(isOpen(mesh)).toBe(false);

    const stamped = await applyTrustedStores({
      config,
      steps: [openMeshStep(mesh, true)],
      logger: noopLogger,
    });

    expect(stamped).toBe(true);
    expect(isOpen(mesh)).toBe(false);
  });

  it('opens it whatever the posture: Careful is about asking, not who may talk', async () => {
    const config = memoryConfig({ ...USER_CONFIG_DEFAULTS.permissions, preset: 'careful' });
    await applyTrustedStores({ config, steps: [openMeshStep(mesh, true)], logger: noopLogger });
    expect(isOpen(mesh)).toBe(true);
  });

  it('waits for Relay: no stamp on a boot with Relay off, so the next boot opens it', async () => {
    const config = memoryConfig();

    expect(
      await applyTrustedStores({
        config,
        steps: [openMeshStep(mesh, false)],
        logger: noopLogger,
      })
    ).toBe(false);
    expect(config.get().trustedStoresAppliedAt).toBeNull();
    expect(isOpen(mesh)).toBe(false);

    await applyTrustedStores({ config, steps: [openMeshStep(mesh, true)], logger: noopLogger });
    expect(isOpen(mesh)).toBe(true);
    expect(config.get().trustedStoresAppliedAt).not.toBeNull();
  });

  it('stamps only when every step applied, and a throwing step does not stop the boot', async () => {
    const config = memoryConfig();
    const failing: TrustedStoreStep = {
      name: 'connected apps',
      run: () => {
        throw new Error('store not ready');
      },
    };

    const stamped = await applyTrustedStores({
      config,
      steps: [openMeshStep(mesh, true), failing],
      logger: noopLogger,
    });

    expect(stamped).toBe(false);
    expect(config.get().trustedStoresAppliedAt).toBeNull();
    expect(config.set).not.toHaveBeenCalled();
  });

  it('keeps the rest of the permissions section when it stamps', async () => {
    const config = memoryConfig({
      ...USER_CONFIG_DEFAULTS.permissions,
      preset: 'careful',
      defaults: { areas: { rooms: 'ask' }, actions: {} },
    });
    await applyTrustedStores({ config, steps: [openMeshStep(mesh, true)], logger: noopLogger });
    expect(config.get().preset).toBe('careful');
    expect(config.get().defaults.areas).toEqual({ rooms: 'ask' });
  });

  it('leaves a Careful install closed, and still counts the step as done', async () => {
    const allowCrossNamespace = vi.fn();
    const step = openMeshStep({ allowCrossNamespace }, true, () => false);
    expect(await step.run()).toBe('applied');
    expect(allowCrossNamespace).not.toHaveBeenCalled();
  });
});
