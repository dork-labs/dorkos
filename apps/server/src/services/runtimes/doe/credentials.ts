import { isCloudLinked } from '../../core/cloud/v1-client.js';
/** Explicit payer and lazy, endpoint-bound credential resolution for DorkOS. */
import type { ModelDescriptor } from '@dorkos/doe';
import type { InferenceModel, InferenceToken } from '@dork-labs/cloud-api';
import { DoeInferenceConfigSchema, type DoeInferenceConfig } from '@dorkos/shared/config-schema';
import { RUNTIME_CREDITS_PROTOCOLS, type RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import { credentialProvider, type CredentialProvider } from '../../core/credential-provider.js';
import { configManager } from '../../core/config-manager.js';
import { heldCreditsToken, resolveCreditsLaunch } from '../../core/cloud/credits-inference.js';
import { creditsModelsFor, peekCreditsModelsFor } from '../../core/cloud/credits-models.js';
import {
  creditsFormatOf,
  creditsProtocolServed,
  creditsEndpointFor,
  CreditsUnavailableError,
  type CreditsLaunch,
} from '../../core/cloud/credits-protocols.js';
import { doeCredentialId, validateDoeSecret } from '../connect/doe-credentials.js';
import { resolveDoeModel } from './models.js';

/** Only explicit choices reach this declaration; its default format changes no payer. */
export const DOE_CREDITS_SUPPORT = {
  protocol: 'anthropic-messages',
  supportedProtocols: RUNTIME_CREDITS_PROTOCOLS,
  scope: 'conversation',
} as const;

/** Narrow injectable ports. Resolving metadata never reads a secret. */
export interface DoeInferenceDeps {
  credentials?: CredentialProvider;
  providers?: () => Readonly<Record<string, string>>;
  credits?: (protocol: DoeInferenceConfig['protocol']) => Promise<CreditsLaunch>;
  creditsModels?: (protocol: DoeInferenceConfig['protocol']) => Promise<InferenceModel[]>;
}

/** Honest metadata-only readiness. A configured key may still be expired or unavailable. */
export function inspectDoeInference(
  config: DoeInferenceConfig | null,
  providers: () => Readonly<Record<string, string>> = () => configManager.get('providers'),
  creditsReady: (config: DoeInferenceConfig) => boolean = inspectDoeCreditsReady
): { configured: boolean; source?: DoeInferenceConfig['source'] } {
  if (!config || !DoeInferenceConfigSchema.safeParse(config).success) return { configured: false };
  const configured =
    config.source === 'dorkos-credits'
      ? creditsReady(config)
      : config.source !== 'api-key' ||
        Boolean(config.credentialRef ?? providers()[doeCredentialId(config.endpoint)]);
  return { configured, source: config.source };
}

/** A live linked format and known model, checked without minting or catalog requests. */
export interface DoeReadinessDeps {
  linked?: () => boolean;
  token?: () => InferenceToken | null;
  models?: (protocol: DoeInferenceConfig['protocol']) => readonly InferenceModel[];
}
/** Check current link, held format and cached model without any secret or service request. */
export function inspectDoeCreditsReady(
  config: DoeInferenceConfig,
  deps: DoeReadinessDeps = {}
): boolean {
  if (!(deps.linked ?? isCloudLinked)()) return false;
  const token = (deps.token ?? heldCreditsToken)();
  return (
    token !== null &&
    creditsProtocolServed(config.protocol, token) &&
    creditsEndpointFor(token.endpoints, config.protocol) !== null &&
    (deps.models ?? peekCreditsModelsFor)(config.protocol).some(
      (model) =>
        model.id === config.model && model.protocols?.includes(creditsFormatOf(config.protocol))
    )
  );
}

/** Freeze the first-turn bill selected by the existing runtime/agent credits choice. */
export function freezeDoeInference(input: {
  config: DoeInferenceConfig;
  creditsChosen: boolean;
  model?: string;
}): DoeInferenceConfig {
  const config = DoeInferenceConfigSchema.parse(input.config);
  if (!input.creditsChosen)
    return DoeInferenceConfigSchema.parse({ ...config, model: input.model ?? config.model });
  const { credentialRef: _ref, credentialEndpoint: _endpoint, ...metadata } = config;
  return DoeInferenceConfigSchema.parse({
    ...metadata,
    source: 'dorkos-credits',
    model: input.model ?? config.model,
  });
}

/** Resolve one frozen session's inference. Credits refusal never calls another source. */
export async function resolveDoeInference(
  input: DoeInferenceConfig,
  deps: DoeInferenceDeps = {}
): Promise<ModelDescriptor> {
  const config = DoeInferenceConfigSchema.parse(input);
  if (config.source === 'local') return resolveDoeModel(config, async () => undefined);
  if (config.source === 'api-key') {
    return resolveDoeModel(config, async (signal) => {
      signal.throwIfAborted();
      const ref =
        config.credentialRef ??
        (deps.providers ?? (() => configManager.get('providers')))()[
          doeCredentialId(config.endpoint)
        ];
      if (!ref) throw new Error('Save an API key for this endpoint.');
      let resolution;
      try {
        resolution = await (deps.credentials ?? credentialProvider).resolve(ref);
      } catch {
        // Resolver errors may contain secrets; never preserve them in public turn errors.
        // eslint-disable-next-line preserve-caught-error
        throw new Error('The saved API key is unavailable.');
      }
      signal.throwIfAborted();
      if (!resolution.ok) throw new Error('The saved API key is unavailable.');
      validateDoeSecret(resolution.secret);
      return resolution.secret;
    });
  }
  const capabilities: Pick<RuntimeCapabilities, 'credits'> = { credits: DOE_CREDITS_SUPPORT };
  const launch =
    deps.credits ??
    ((protocol) => resolveCreditsLaunch(capabilities, 'DorkOS', undefined, protocol));
  const models = await (deps.creditsModels ?? creditsModelsFor)(config.protocol);
  const model = models.find((candidate) => candidate.id === config.model);
  if (!model) throw new CreditsUnavailableError('no-models', 'DorkOS');
  const first = await launch(config.protocol);
  const metadata = {
    ...config,
    endpoint: first.baseUrl,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
  };
  return resolveDoeModel(metadata, async (signal) => {
    signal.throwIfAborted();
    const current = await launch(config.protocol);
    signal.throwIfAborted();
    if (current.baseUrl !== first.baseUrl)
      throw new CreditsUnavailableError('unreachable', 'DorkOS');
    return current.token;
  });
}
