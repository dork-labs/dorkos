import { AsyncLocalStorage } from 'node:async_hooks';
import { createEgressPolicy } from '../policy.js';
import type { EgressPolicyOptions } from '../settings.js';
import type { CircuitCustody } from './custody.js';
import { BrokerError } from './errors.js';
/** Bind ignored resolver work to its exact acquisition charge until actual callback settlement. */
export function custodyPolicy(options: EgressPolicyOptions) {
  const storage = new AsyncLocalStorage<CircuitCustody>();
  const policy = createEgressPolicy({
    ...options,
    resolver: async (host, signal) => {
      const custody = storage.getStore();
      if (!custody) throw new BrokerError('AUTHORITY_REFUSED');
      const settled = custody.pending();
      try {
        return await options.resolver(host, signal);
      } finally {
        settled();
      }
    },
  });
  return {
    policy,
    authorize(custody: CircuitCustody, input: Parameters<typeof policy.authorize>[0]) {
      return storage.run(custody, () => policy.authorize(input));
    },
  };
}
