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
export { ComposioEventClient, type ComposioEventClientOptions } from './event-client.js';
export { ComposioWebhookVerifier } from './webhook-verifier.js';

export {
  ComposioAuthenticationDescriptorSchema,
  ComposioAuthenticationFieldSchema,
  ComposioFieldSchemeSchema,
  validateComposioAuthenticationFields,
  type ComposioAuthenticationDescriptor,
  type ComposioAuthenticationField,
  type ComposioFieldScheme,
} from './authentication-contract.js';
export {
  matchesComposioAutomaticAuthenticationPolicy,
  normalizeComposioToolkitAuthentication,
  normalizeComposioAuthenticationConfiguration,
  selectComposioAuthentication,
  ComposioAuthenticationSetupError,
  type ComposioToolkitAuthentication,
  type ComposioAuthenticationConfiguration,
  type ComposioAuthenticationMethod,
} from './authentication-configuration.js';
