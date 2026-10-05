import { Server } from 'node:net';
import type { EgressBinding } from '../../settings.js';
import { BrokerError } from '../errors.js';

type LocalOwner = {
  grantLocal(
    url: string,
    protocol: 'http' | 'websocket' | 'websocket-connect',
    ttl: number
  ): unknown;
  revokeLocal(): void;
};
const same = (a: EgressBinding, b: EgressBinding) =>
  a.ownerId === b.ownerId &&
  a.workspaceId === b.workspaceId &&
  a.browserId === b.browserId &&
  a.browserGeneration === b.browserGeneration;
const endpoint = (original: Server) => {
  const address = original.address();
  if (
    !original.listening ||
    !address ||
    typeof address === 'string' ||
    !['127.0.0.1', '::1'].includes(address.address)
  )
    throw new BrokerError('AUTHORITY_REFUSED');
  return `http://${address.address === '::1' ? '[::1]' : address.address}:${address.port}`;
};

/** Original local consent is checked by authority on every forwarding operation. */
export function createFixtureOriginCustody() {
  const originals = new Map<
    Server,
    {
      binding: EgressBinding;
      broker: LocalOwner;
      url: string;
      alive: boolean;
      failed: boolean;
      transports: Set<'http' | 'websocket' | 'websocket-connect'>;
    }
  >();
  let attempts = 0;
  const refuse = (owner: { broker: LocalOwner; alive: boolean; failed: boolean }) => {
    owner.alive = false;
    owner.failed = true; // A restarted listener cannot resurrect this consent.
    try {
      owner.broker.revokeLocal();
    } catch {
      // Sticky owner refusal remains even if original broker revocation fails.
    }
  };
  const check = (binding: EgressBinding) => {
    for (const [original, owner] of originals) {
      if (!same(binding, owner.binding)) continue;
      try {
        if (owner.failed || !owner.alive || endpoint(original) !== owner.url)
          throw new BrokerError('AUTHORITY_REFUSED');
      } catch (error) {
        refuse(owner);
        throw error;
      }
    }
  };
  return Object.freeze({
    check,
    grant(
      original: Server,
      binding: EgressBinding,
      broker: LocalOwner,
      ttl: number,
      transport: 'http' | 'websocket' | 'websocket-connect' = 'http'
    ) {
      if (transport !== 'http' && transport !== 'websocket' && transport !== 'websocket-connect')
        throw new BrokerError('AUTHORITY_REFUSED');
      check(binding);
      const previous = originals.get(original);
      if (previous) {
        if (
          !same(binding, previous.binding) ||
          previous.broker !== broker ||
          previous.transports.has(transport)
        )
          throw new BrokerError('AUTHORITY_REFUSED');
        const url = transport !== 'http' ? previous.url.replace(/^http:/, 'ws:') : previous.url;
        try {
          previous.transports.add(transport); // Charge before authority callbacks can reenter.
          broker.grantLocal(url, transport, ttl);
          check(binding);
          return url;
        } catch (error) {
          refuse(previous);
          throw error;
        }
      }
      if (!(original instanceof Server) || originals.has(original) || attempts >= 64)
        throw new BrokerError('AUTHORITY_REFUSED');
      attempts++;
      const owner = {
        binding: Object.freeze({ ...binding }),
        broker,
        url: '',
        alive: true,
        failed: false,
        transports: new Set<'http' | 'websocket' | 'websocket-connect'>(),
      };
      originals.set(original, owner); // Before address inspection or consent issuance can throw.
      original.once('close', () => refuse(owner));
      try {
        owner.url = endpoint(original);
        const url = transport !== 'http' ? owner.url.replace(/^http:/, 'ws:') : owner.url;
        owner.transports.add(transport);
        broker.grantLocal(url, transport, ttl);
        check(binding);
        return url;
      } catch (error) {
        refuse(owner);
        throw error;
      }
    },
    url(original: Server, binding: EgressBinding) {
      check(binding);
      const owner = originals.get(original);
      if (!owner || !same(binding, owner.binding) || !owner.transports.has('http'))
        throw new BrokerError('AUTHORITY_REFUSED');
      return owner.url;
    },
  });
}
