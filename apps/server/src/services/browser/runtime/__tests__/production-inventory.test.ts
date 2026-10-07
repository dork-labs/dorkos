import { EventEmitter } from 'node:events';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { createProductionBrowserServerInventory } from '../production-inventory.js';
const controls = vi.hoisted(() => ({
  tunnel: vi.fn(),
  receiver: undefined as EventEmitter | undefined,
}));
vi.mock('../../../core/tunnel-manager.js', () => ({
  tunnelManager: {
    on(...args: Parameters<EventEmitter['on']>) {
      controls.receiver ??= new EventEmitter();
      return controls.receiver.on(...args);
    },
    off(...args: Parameters<EventEmitter['off']>) {
      return controls.receiver!.off(...args);
    },
  },
}));
vi.mock('../../../../lib/trusted-origins.js', () => ({ getTunnelOrigin: controls.tunnel }));
afterEach(() => vi.clearAllMocks());
it('retains every actual tunnel deny and revises sealed policy when the original alias changes', () => {
  // Native interface enumeration is the actual server inventory producer; no positive
  // local listener custody is manufactured (its required main slot stays unacquired).
  controls.tunnel.mockReturnValue('https://first.example');
  const owner: { value?: ReturnType<typeof createProductionBrowserServerInventory> } = {};
  onTestFinished(async () => {
    if (owner.value) await owner.value.close();
  });
  const original = (owner.value = createProductionBrowserServerInventory());
  const first = original.observe();
  expect(first.inventory.localCoverageComplete).toBe(false);
  expect(first.policyInputs?.adminAuthorities).toEqual(['https://first.example']);
  controls.tunnel.mockReturnValue('https://second.example');
  const second = original.observe();
  expect(second.inventory.revision).toBeGreaterThan(first.inventory.revision);
  expect(second.policyInputs?.adminAuthorities).toEqual([
    'https://first.example',
    'https://second.example',
  ]);
  controls.tunnel.mockReturnValue(null);
  expect(original.observe().policyInputs?.adminAuthorities).toEqual(
    second.policyInputs?.adminAuthorities
  );
});
it('retains unknown administrative capacity and never converts it to ready coverage', () => {
  const owner: { value?: ReturnType<typeof createProductionBrowserServerInventory> } = {};
  onTestFinished(async () => {
    if (owner.value) await owner.value.close();
  });
  const original = (owner.value = createProductionBrowserServerInventory());
  for (let index = 0; index < 128; index++) {
    controls.tunnel.mockReturnValue(`https://owned-${index}.example`);
    original.observe();
  }
  controls.tunnel.mockReturnValue('https://overflow.example');
  expect(() => original.observe()).toThrow('Administrative inventory exhausted');
  controls.tunnel.mockReturnValue(null);
  expect(() => original.observe()).toThrow('Administrative inventory exhausted');
});

it('retains original tunnel aliases observed while Off and removes the original listener on close', async () => {
  controls.receiver = new EventEmitter();
  controls.tunnel.mockReturnValue(undefined);
  const originals: {
    owner?: ReturnType<typeof createProductionBrowserServerInventory>;
    close?: Promise<void>;
  } = {};
  onTestFinished(async () => {
    if (originals.owner) originals.close ??= originals.owner.close();
    if (originals.close) await originals.close;
  });
  originals.owner = createProductionBrowserServerInventory();
  controls.tunnel.mockReturnValue('https://first.example.com');
  controls.receiver.emit('status_change', {});
  controls.tunnel.mockReturnValue('https://second.example.com');
  controls.receiver.emit('status_change', {});
  const observed = originals.owner.observe();
  expect(observed.policyInputs?.adminAuthorities).toContain('https://first.example.com');
  expect(observed.policyInputs?.adminAuthorities).toContain('https://second.example.com');
  originals.close = originals.owner.close();
  await originals.close;
  expect(controls.receiver.listenerCount('status_change')).toBe(0);
});
