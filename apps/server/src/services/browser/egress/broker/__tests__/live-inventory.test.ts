import { createServer } from 'node:net';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { createServerInventory } from '../server-inventory.js';
import { createNodeBrokerTransport } from '../node-transport.js';
import { createLiveBrowserInventory } from '../live/live-inventory.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  let failed = false;
  let first: unknown;
  for (const close of cleanups.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      if (!failed) first = error;
      failed = true;
    }
  }
  if (failed) throw first;
});
async function fixture() {
  const base = createServerInventory({
    instances: [{ id: 'server', listeners: ['http'] }],
    adminAuthorities: [],
    now: () => 0,
  });
  const server = base.acquire(
    'server',
    'http',
    () => {
      const original = createServer();
      cleanups.push(
        () =>
          new Promise<void>((resolve, reject) =>
            original.close((error) => (error ? reject(error) : resolve()))
          )
      );
      return original;
    },
    (original) => original.listen(0, '127.0.0.1')
  );
  await once(server, 'listening');
  const transport = createNodeBrokerTransport();
  let closed = false;
  let finish!: () => void;
  const returned = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const listener = await transport.listen({
    maxConnections: 1,
    headerBytes: 8192,
    headerMs: 1000,
    reserveSocket: () => undefined,
    onSocket: () => false,
    onListener: (original) => {
      original.onClose(() => {
        closed = true;
        finish();
      });
      cleanups.push(async () => {
        if (!closed) original.close();
        await returned;
      });
      return true;
    },
    onRequest: () => {
      throw new Error('Unexpected fixture request');
    },
    onPipeline: () => {},
  });
  const inventory = createLiveBrowserInventory(base);
  // This owner method is a semantic engine-proof control; the listener/base census are real Node originals.
  let proof: {
    url: string;
    root: { pid: number; birth: string };
    supervisor: { pid: number; birth: string };
  } | null = {
    url: 'http://127.0.0.1:6402',
    root: { pid: 100, birth: 'root' },
    supervisor: { pid: 101, birth: 'supervisor' },
  };
  const receiver = { verifiedBrowserAdminEndpoint: () => proof };
  return {
    inventory,
    listener,
    returned,
    receiver,
    setProof: (value: typeof proof) => {
      proof = value;
    },
  };
}
it('retains actual broker endpoint and once-sealed admin deny after original listener closes', async () => {
  const f = await fixture();
  const before = f.inventory.readInventory().revision;
  f.inventory.retainListener(f.listener, f.receiver);
  f.inventory.retainBrowserAdmin(f.listener.identity);
  const sealed = f.inventory.readInventory();
  expect(sealed.revision).toBeGreaterThan(before);
  expect(sealed.protectedEndpoints).toContainEqual({ address: '127.0.0.1', port: f.listener.port });
  expect(sealed.protectedEndpoints).toContainEqual({ address: '127.0.0.1', port: 6402 });
  expect(sealed.localCoverageComplete).toBe(true);
  f.listener.close();
  await f.returned;
  const after = f.inventory.readInventory();
  expect(after.protectedEndpoints).toEqual(sealed.protectedEndpoints);
  expect(after.localCoverageComplete).toBe(false);
});
it('missing original admin proof refuses and cannot become a positive seal later', async () => {
  const f = await fixture();
  f.inventory.retainListener(f.listener, f.receiver);
  f.setProof(null);
  expect(() => f.inventory.retainBrowserAdmin(f.listener.identity)).toThrow('AUTHORITY_REFUSED');
  f.setProof({
    url: 'http://127.0.0.1:6402',
    root: { pid: 100, birth: 'root' },
    supervisor: { pid: 101, birth: 'supervisor' },
  });
  expect(() => f.inventory.readInventory()).toThrow('AUTHORITY_REFUSED');
});
it('sealed original cannot replace its admin endpoint with another owner claim', async () => {
  const f = await fixture();
  f.inventory.retainListener(f.listener, f.receiver);
  f.inventory.retainBrowserAdmin(f.listener.identity);
  f.setProof({
    url: 'http://127.0.0.1:6403',
    root: { pid: 100, birth: 'root' },
    supervisor: { pid: 101, birth: 'supervisor' },
  });
  expect(() => f.inventory.retainBrowserAdmin(f.listener.identity)).toThrow('AUTHORITY_REFUSED');
  expect(f.inventory.readInventory().protectedEndpoints).not.toContainEqual({
    address: '127.0.0.1',
    port: 6403,
  });
});
