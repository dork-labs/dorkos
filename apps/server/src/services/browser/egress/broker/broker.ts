import { createBrokerCore } from './broker-core.js';
import { BrokerError } from './errors.js';
import type { BrokerTransport } from './transport.js';
import type { PreparedRunReceiver } from './issuer.js';

/** Existing fixture constructor remains fixture-only; production has a separate original producer. */
export function createPrivateBroker(
  options: Omit<Parameters<typeof createBrokerCore>[0], 'transport'> & {
    transport: BrokerTransport;
  }
) {
  if (options.transport.scope !== 'fixture-only') throw new BrokerError('UNAVAILABLE');
  return createBrokerCore(options);
}

/** Prelaunch capacity and exact original intake, never a prepared forwarding authority. */
export function createPreparedPrivateBroker(
  options: Omit<Parameters<typeof createPrivateBroker>[0], 'preparedReceiver'> & {
    receiver: PreparedRunReceiver;
  }
) {
  return createPrivateBroker({ ...options, preparedReceiver: options.receiver });
}
