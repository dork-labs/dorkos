/** Map vendor event account handles at the existing Composio confinement boundary. */
import type { ConnectorEventCapability } from '@dorkos/shared/connector-events';
import type { ConnectorExternalAccountRef } from '@dorkos/shared/connector-schemas';
import { toComposioAccountId, toExternalAccountRef } from './composio.js';

/** Wrap the SDK event capability so registry consumers only handle private port references. */
export function composioEventCapability(
  client: ConnectorEventCapability
): ConnectorEventCapability {
  return {
    listDefinitions: (request) => client.listDefinitions(request),
    async reconcileTrigger(input) {
      const result = await client.reconcileTrigger({
        ...input,
        externalAccountRef: toComposioAccountId(
          input.externalAccountRef as ConnectorExternalAccountRef
        ),
      });
      if (result.status !== 'found') return result;
      return {
        ...result,
        trigger: {
          ...result.trigger,
          externalAccountRef: toExternalAccountRef(result.trigger.externalAccountRef),
        },
      };
    },
    createTrigger: (input) =>
      client.createTrigger({
        ...input,
        externalAccountRef: toComposioAccountId(
          input.externalAccountRef as ConnectorExternalAccountRef
        ),
      }),
    setTriggerEnabled: (input) => client.setTriggerEnabled(input),
    deleteTrigger: (input) => client.deleteTrigger(input),
    async verifyWebhook(input) {
      const result = await client.verifyWebhook(input);
      if (result.status !== 'verified') return result;
      return {
        ...result,
        event: {
          ...result.event,
          externalAccountRef: toExternalAccountRef(result.event.externalAccountRef),
        },
      };
    },
  };
}
