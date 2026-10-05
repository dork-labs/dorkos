import type { createServerInventory } from '../server-inventory.js';
import type { OwnedListener } from '../transport.js';
import { BrokerError } from '../errors.js';

/** Permanent denies acquired from private original owners, never from website JSON. */
type AdminProof = Readonly<{
  url: string;
  root: { pid: number; birth: string };
  supervisor: { pid: number; birth: string };
}>;
type AdminOwner = { verifiedBrowserAdminEndpoint(): AdminProof | null };
/** Combine the actual server census with permanently retained private original endpoint denies. */
export function createLiveBrowserInventory(base: ReturnType<typeof createServerInventory>) {
  const originals = new Map<
    object,
    {
      listener: OwnedListener;
      closed: boolean;
      readAdmin: () => AdminProof | null;
      sealed: boolean;
    }
  >();
  const denies = new Map<string, Readonly<{ address: string; port: number }>>();
  let failed = false,
    revision = 0,
    fingerprint = '';
  const deny = (address: string, port: number) => {
    if (
      !['127.0.0.1', '::1'].includes(address) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    )
      throw new BrokerError('AUTHORITY_REFUSED');
    const key = JSON.stringify([address, port]);
    if (!denies.has(key) && denies.size >= 128) throw new BrokerError('QUOTA');
    denies.set(key, Object.freeze({ address, port }));
  };
  const observe = () => {
    if (failed) throw new BrokerError('AUTHORITY_REFUSED');
    try {
      const snapshot = base.observe();
      const endpoints = new Map(denies);
      for (const endpoint of snapshot.inventory.protectedEndpoints)
        endpoints.set(JSON.stringify([endpoint.address, endpoint.port]), endpoint);
      if (endpoints.size > 128) throw new BrokerError('QUOTA');
      const protectedEndpoints = Object.freeze(
        [...endpoints.values()].sort(
          (a, b) => a.address.localeCompare(b.address) || a.port - b.port
        )
      );
      const next = JSON.stringify([snapshot.inventory.revision, protectedEndpoints]);
      if (next !== fingerprint) {
        if (revision === Number.MAX_SAFE_INTEGER) throw new BrokerError('QUOTA');
        revision++;
        fingerprint = next;
      }
      const inventory = Object.freeze({
        ...snapshot.inventory,
        revision,
        protectedEndpoints,
        localCoverageComplete:
          snapshot.inventory.localCoverageComplete &&
          [...originals.values()].every((original) => !original.closed),
      });
      return Object.freeze({
        ...snapshot,
        inventory,
        policyInputs: snapshot.policyInputs
          ? Object.freeze({ ...snapshot.policyInputs, privateAdminEndpoints: protectedEndpoints })
          : null,
      });
    } catch (error) {
      failed = true;
      throw error;
    }
  };
  return Object.freeze({
    acquire: base.acquire,
    observe,
    readInventory: () => observe().inventory,
    retainListener(original: OwnedListener, receiver: AdminOwner) {
      if (failed || originals.has(original.identity) || originals.size >= 64)
        throw new BrokerError('AUTHORITY_REFUSED');
      const readAdmin = receiver.verifiedBrowserAdminEndpoint;
      if (typeof readAdmin !== 'function') throw new BrokerError('AUTHORITY_REFUSED');
      const state = {
        listener: original,
        closed: false,
        sealed: false,
        readAdmin: () => Reflect.apply(readAdmin, receiver, []) as AdminProof | null,
      };
      originals.set(original.identity, state); // Before the first fallible owner callback.
      try {
        original.onClose(() => {
          state.closed = true;
        });
        deny(original.address, original.port);
      } catch (error) {
        failed = true;
        throw error;
      }
    },
    retainBrowserAdmin(original: object) {
      const state = originals.get(original);
      if (failed || !state || state.closed || state.sealed)
        throw new BrokerError('AUTHORITY_REFUSED');
      try {
        const proof = state.readAdmin();
        if (
          !proof ||
          proof.root.pid === proof.supervisor.pid ||
          !proof.root.birth ||
          !proof.supervisor.birth
        )
          throw new BrokerError('AUTHORITY_REFUSED');
        const url = new URL(proof.url);
        if (url.origin !== proof.url || url.protocol !== 'http:' || url.username || url.password)
          throw new BrokerError('AUTHORITY_REFUSED');
        deny(url.hostname === '[::1]' ? '::1' : url.hostname, Number(url.port));
        state.sealed = true;
      } catch (error) {
        failed = true;
        throw error;
      }
    },
  });
}
