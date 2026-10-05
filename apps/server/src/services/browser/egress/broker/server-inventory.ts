import { Server } from 'node:net';
import { networkInterfaces } from 'node:os';
import { classifyAddress } from '../addresses.js';
import { parseDestination } from '../destination.js';
import type { InventoryObservation } from './authority.js';
import { checkedClock } from './clock.js';

/** Config-owned listener declarations. This is not a census of every process on the host. */
export interface ServerInventoryOptions {
  readonly instances: readonly { readonly id: string; readonly listeners: readonly string[] }[];
  readonly adminAuthorities: readonly string[];
  readonly now: () => number;
}

/** Policy inputs and local coverage come from the same native sampling operation. */
export interface ServerInventorySnapshot {
  readonly inventory: InventoryObservation;
  readonly interfacesKnown: boolean;
  /** Null until an actual interface census succeeds; never invent an empty successful census. */
  readonly policyInputs: {
    readonly adminAuthorities: readonly string[];
    readonly hostInterfaces: readonly string[];
    readonly privateAdminEndpoints: readonly { readonly address: string; readonly port: number }[];
  } | null;
}

/**
 * Observe original server handles without mounting a listener or owning their shutdown.
 * An acquisition attempt occupies its declared slot even when its factory throws.
 * Closed, missing and uncertain listeners revoke local coverage rather than prove absence.
 */
export function createServerInventory(options: ServerInventoryOptions) {
  const declarations = new Map<
    string,
    Map<string, { server?: Server; uncertain: boolean; failed: boolean }>
  >();
  const validId = (value: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(value);
  let slots = 0;
  if (
    !options.instances.length ||
    options.instances.length > 64 ||
    options.adminAuthorities.length > 128
  )
    throw new Error('Invalid server inventory configuration');
  for (const instance of options.instances) {
    if (!validId(instance.id) || declarations.has(instance.id) || !instance.listeners.length)
      throw new Error('Invalid server inventory declaration');
    const listeners = new Map<string, { server?: Server; uncertain: boolean; failed: boolean }>();
    for (const listener of instance.listeners) {
      // A dual-stack wildcard contributes two protected policy endpoints. The
      // existing policy's 128-endpoint bound therefore allows 64 listener slots.
      if (!validId(listener) || listeners.has(listener) || ++slots > 64)
        throw new Error('Invalid server inventory declaration');
      listeners.set(listener, { uncertain: false, failed: false });
    }
    declarations.set(instance.id, listeners);
  }
  const adminAuthorities = Object.freeze(
    options.adminAuthorities.map((authority) => {
      if (authority.length > 512) throw new Error('Invalid administrative authority');
      parseDestination({ url: authority });
      return authority;
    })
  );
  const attempted = new Set<object>();
  const retainedServers = new Set<Server>();
  const interfaceDenies = new Set<string>();
  const endpointDenies = new Map<string, { address: string; port: number }>();
  let hadInterfaces = false;
  let revision = 0;
  let fingerprint = '';
  let interfaceCapacityUnknown = false;
  let endpointCapacityUnknown = false;
  const clock = checkedClock(options.now, () => {});

  /** Retain the exact handle before the fallible listen callback; never retry a lost acquisition. */
  function acquire<T extends Server>(
    instanceId: string,
    listenerId: string,
    createOriginal: () => T,
    listenOriginal: (server: T) => void
  ): T {
    const slot = declarations.get(instanceId)?.get(listenerId);
    if (!slot || attempted.has(slot)) throw new Error('Unknown or occupied inventory listener');
    attempted.add(slot);
    slot.uncertain = true;
    const server = createOriginal();
    if (!(server instanceof Server) || retainedServers.has(server))
      throw new Error('Inventory requires a distinct original server');
    retainedServers.add(server);
    slot.server = server;
    server.on('error', () => {
      slot.uncertain = true;
      slot.failed = true;
    });
    server.on('close', () => {
      slot.uncertain = true;
      slot.failed = true;
    });
    // Only this acquisition's listening event can establish coverage. A later reuse
    // of a closed original handle must not silently restore a retired inventory slot.
    server.once('listening', () => {
      if (!slot.failed) slot.uncertain = false;
    });
    try {
      listenOriginal(server);
    } catch (error) {
      slot.uncertain = true;
      slot.failed = true;
      throw error;
    }
    return server;
  }

  function observe(): ServerInventorySnapshot {
    // A newly observed permanent deny that cannot be retained stays unresolved
    // for this generation, even if a later census no longer contains it.
    if (interfaceCapacityUnknown) throw new Error('Interface inventory exhausted');
    if (endpointCapacityUnknown) throw new Error('Protected endpoint inventory exhausted');
    const now = clock();
    if (now > Number.MAX_SAFE_INTEGER - 1000) throw new Error('Invalid server inventory clock');
    let interfacesKnown = false;
    try {
      const interfaces = networkInterfaces();
      const addresses: string[] = [];
      let count = 0;
      for (const entries of Object.values(interfaces)) {
        if (!entries) throw new Error('Unknown interface coverage');
        for (const entry of entries) {
          count++;
          const address = classifyAddress(entry.address);
          if (entry.family !== (address.family === 4 ? 'IPv4' : 'IPv6'))
            throw new Error('Unknown interface family');
          if (address.address !== '127.0.0.1' && address.address !== '::1')
            addresses.push(address.address);
        }
      }
      if (!count) throw new Error('Unknown interface coverage');
      if (new Set([...interfaceDenies, ...addresses]).size > 256) {
        interfaceCapacityUnknown = true;
        throw new Error('Interface inventory exhausted');
      }
      for (const address of addresses) interfaceDenies.add(address);
      interfacesKnown = true;
      hadInterfaces = true;
    } catch {
      // Keep every previously observed host address denied while local admission closes.
    }
    if (interfaceCapacityUnknown) throw new Error('Interface inventory exhausted');
    const coveredInstances: string[] = [];
    for (const [instance, listeners] of declarations) {
      let complete = true;
      for (const slot of listeners.values()) {
        try {
          const address = slot.server?.address();
          if (!slot.server?.listening || !address || typeof address === 'string') {
            complete = false;
            continue;
          }
          if (!Number.isInteger(address.port) || address.port < 1 || address.port > 65535)
            throw new Error('Unknown listener port');
          const host = classifyAddress(address.address).address;
          if (!['127.0.0.1', '::1', '0.0.0.0', '::'].includes(host)) {
            if (!interfaceDenies.has(host) && interfaceDenies.size >= 256) {
              interfaceCapacityUnknown = true;
              throw new Error('Interface inventory exhausted');
            }
            interfaceDenies.add(host);
          }
          const protectedHosts =
            host === '::'
              ? ['127.0.0.1', '::1']
              : host === '0.0.0.0'
                ? ['127.0.0.1']
                : host === '127.0.0.1' || host === '::1'
                  ? [host]
                  : [];
          for (const protectedHost of protectedHosts) {
            if (
              !endpointDenies.has(`${protectedHost}:${address.port}`) &&
              endpointDenies.size >= 128
            ) {
              endpointCapacityUnknown = true;
              throw new Error('Protected endpoint inventory exhausted');
            }
            endpointDenies.set(`${protectedHost}:${address.port}`, {
              address: protectedHost,
              port: address.port,
            });
          }
          if (slot.uncertain) complete = false;
        } catch {
          complete = false;
        }
      }
      if (complete) coveredInstances.push(instance);
    }
    if (endpointCapacityUnknown) throw new Error('Protected endpoint inventory exhausted');
    if (interfaceCapacityUnknown) throw new Error('Interface inventory exhausted');
    const protectedEndpoints = [...endpointDenies.values()].sort(
      (a, b) => a.address.localeCompare(b.address) || a.port - b.port
    );
    const hostInterfaces = [...interfaceDenies].sort();
    // Coverage gaps revoke local grants independently. Retain every known deny
    // and preserve public circuits until the security policy itself changes.
    const nextFingerprint = JSON.stringify([protectedEndpoints, hostInterfaces]);
    if (nextFingerprint !== fingerprint) {
      if (revision === Number.MAX_SAFE_INTEGER) throw new Error('Inventory revision exhausted');
      revision++;
      fingerprint = nextFingerprint;
    }
    const inventory: InventoryObservation = Object.freeze({
      revision,
      publicAuthoritiesKnown: true,
      localCoverageComplete: interfacesKnown && coveredInstances.length === declarations.size,
      validUntil: now + 1000,
      protectedEndpoints: Object.freeze(
        protectedEndpoints.map((endpoint) => Object.freeze(endpoint))
      ),
      declaredInstances: Object.freeze([...declarations.keys()]),
      coveredInstances: Object.freeze(coveredInstances),
    });
    return Object.freeze({
      inventory,
      interfacesKnown,
      policyInputs: hadInterfaces
        ? Object.freeze({
            adminAuthorities,
            hostInterfaces: Object.freeze(hostInterfaces),
            privateAdminEndpoints: inventory.protectedEndpoints,
          })
        : null,
    });
  }

  return Object.freeze({ acquire, observe, readInventory: () => observe().inventory });
}
