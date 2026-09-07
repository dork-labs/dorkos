/** Composio SDK adapter and provider-facing operation contract. */
export {
  ComposioCatalogError,
  ComposioSdkClient,
  type ComposioOperationClient,
  type ComposioSdkClientOpts,
  type ComposioSdkExecuteInput,
} from './sdk-client.js';
export {
  ComposioManagedAccountClient,
  ComposioManagedAccountError,
  type ComposioManagedAccount,
  type ComposioManagedAccountClientOpts,
  type ComposioManagedLink,
} from './managed-account-client.js';
export {
  createComposioHostedClients,
  type ComposioHostedClientMaterial,
  type ComposioHostedClients,
} from './hosted-client-factory.js';
