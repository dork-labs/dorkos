import { Server } from 'node:net';
import type { EgressBinding } from '../../settings.js';
import { BrokerError } from '../errors.js';

type LocalOwner = {
  grantLocal(url: string, protocol: 'http', ttl: number): unknown;
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
    grant(original: Server, binding: EgressBinding, broker: LocalOwner, ttl: number) {
      if (!(original instanceof Server) || originals.has(original) || attempts >= 64)
        throw new BrokerError('AUTHORITY_REFUSED');
      attempts++;
      const owner = {
        binding: Object.freeze({ ...binding }),
        broker,
        url: '',
        alive: true,
        failed: false,
      };
      originals.set(original, owner); // Before address inspection or consent issuance can throw.
      original.once('close', () => refuse(owner));
      try {
        owner.url = endpoint(original);
        broker.grantLocal(owner.url, 'http', ttl);
        check(binding);
        return owner.url;
      } catch (error) {
        refuse(owner);
        throw error;
      }
    },
    url(original: Server, binding: EgressBinding) {
      check(binding);
      const owner = originals.get(original);
      if (!owner || !same(binding, owner.binding)) throw new BrokerError('AUTHORITY_REFUSED');
      return owner.url;
    },
  });
}
