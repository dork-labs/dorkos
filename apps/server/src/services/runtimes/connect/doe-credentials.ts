/** Encrypted DorkOS key setup with endpoint-scoped references and no vendor process. */
import { createHash, randomUUID } from 'node:crypto';
import {
  DoeInferenceConfigSchema,
  type DoeInferenceConfig,
  type UserConfig,
} from '@dorkos/shared/config-schema';
import { credentialStore, type CredentialStore } from '../../core/credential-provider.js';
import { configManager } from '../../core/config-manager.js';
import { logConfigWrite } from '../../core/operator/config-write.js';
import type { ConfigReadWrite } from './persist-provider-credential.js';
import { ConnectError } from './connect-error.js';

/** Credential registry key for exactly one endpoint, including its path. */
export function doeCredentialId(endpoint: string): string {
  return `doe-${createHash('sha256').update(new URL(endpoint).href).digest('hex')}`;
}

/** Reject subscription credentials before a store, config read, or HTTP request. */
export function validateDoeSecret(secret: string): void {
  if (!secret.trim()) throw new ConnectError('Enter an API key.', 400);
  if (secret.trim().startsWith('sk-ant-oat')) {
    throw new ConnectError(
      'Anthropic subscription tokens cannot run DorkOS agents. Use an API key.',
      400
    );
  }
}

/** Injectable write ports; no validation request sends a secret to an inferred endpoint. */
export interface StoreDoeCredentialDeps {
  store?: CredentialStore;
  config?: ConfigReadWrite;
}

/** Save an explicitly supplied key and inference metadata. Return metadata only. */
export async function storeDoeCredential(
  input: DoeInferenceConfig,
  secret: string,
  deps: StoreDoeCredentialDeps = {}
): Promise<DoeInferenceConfig> {
  validateDoeSecret(secret);
  const inference = DoeInferenceConfigSchema.parse(input);
  if (inference.source !== 'api-key') throw new ConnectError('Choose an API key source.', 400);
  const store = deps.store ?? credentialStore;
  const config = deps.config ?? configManager;
  const id = doeCredentialId(inference.endpoint);
  const ref = await store.put(`${id}-${randomUUID()}`, secret.trim());
  // The asynchronous encrypted write must not pin stale config sections.
  let previousProviders: UserConfig['providers'];
  let previousRuntimes: UserConfig['runtimes'];
  try {
    previousProviders = config.get('providers');
    previousRuntimes = config.get('runtimes');
  } catch {
    await store.delete(ref.slice('file:'.length)).catch(() => {});
    throw new ConnectError('Could not save the API key.', 500);
  }
  const next = {
    ...inference,
    credentialRef: ref,
    credentialEndpoint: new URL(inference.endpoint).href,
  };
  const nextProviders = { ...previousProviders, [id]: ref };
  const nextRuntimes = {
    ...previousRuntimes,
    doe: { ...previousRuntimes.doe, inference: next },
  };
  try {
    config.set('providers', nextProviders);
    config.set('runtimes', nextRuntimes);
  } catch {
    try {
      config.set('providers', previousProviders);
      config.set('runtimes', previousRuntimes);
    } catch {
      /* Preserve the original setup refusal when rollback also fails. */
    }
    await store.delete(ref.slice('file:'.length)).catch(() => {});
    throw new ConnectError('Could not save the API key.', 500);
  }
  logConfigWrite('the DorkOS API key setup', 'providers', previousProviders, nextProviders);
  logConfigWrite('the DorkOS API key setup', 'runtimes', previousRuntimes, nextRuntimes);
  return next;
}
