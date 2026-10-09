import { readOriginalProcessNativeProjection } from '../../runtime/private-native-projection.js';
import { createBrokerCore } from './broker-core.js';
import {
  createProductionNodeBrokerTransport,
  isOriginalProductionNodeTransport,
} from './node/node-transport.js';
import type { PreparedRunReceiver } from './issuer.js';
import { BrokerError } from './errors.js';

/** Production cold owner: genuine issuer/run/receiver checks precede original Node listen.
 * No injected fixture IO or tag/callback can substitute for the actual Node producer.
 * This remains cold until original native authority, inventory and policy activation all pass. */
export function createPreparedProductionBroker(
  options: Omit<Parameters<typeof createBrokerCore>[0], 'transport' | 'preparedReceiver'> & {
    receiver: PreparedRunReceiver;
  }
) {
  options.issuer.checkPrepared(options.run, options.receiver);
  const transport = createProductionNodeBrokerTransport();
  if (!isOriginalProductionNodeTransport(transport)) throw new BrokerError('UNAVAILABLE');
  options.issuer.checkPrepared(options.run, options.receiver);
  return createBrokerCore({
    ...options,
    transport,
    preparedReceiver: options.receiver,
    connectDenials: readOriginalProcessNativeProjection()?.connectDenials,
  });
}
