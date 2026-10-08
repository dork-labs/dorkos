/** Model metadata stays separate from per-request secret resolution. */
import type { ModelDescriptor } from '@dorkos/doe';
import { DoeInferenceConfigSchema, type DoeInferenceConfig } from '@dorkos/shared/config-schema';
import type { ModelOption } from '@dorkos/shared/types';

/** Deliberate translation between platform and engine protocol names. */
export function doeProtocol(protocol: DoeInferenceConfig['protocol']): ModelDescriptor['protocol'] {
  return protocol === 'openai-chat-completions' ? 'openai-completions' : protocol;
}

/** Stable model-history family; request format changes cannot reinterpret old messages. */
export function doeHistoryFamily(config: DoeInferenceConfig): string {
  return `${config.protocol}:${new URL(config.endpoint).origin}`;
}

/** Configured models only: listing never fetches credentials or starts another runtime. */
export function listDoeModels(config: DoeInferenceConfig | null): ModelOption[] {
  if (!config) return [];
  const model = DoeInferenceConfigSchema.parse(config);
  return [
    {
      value: model.model,
      displayName: model.model.length <= 13 ? model.model : `${model.model.slice(0, 12)}…`,
      description: '',
      isDefault: true,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      supportsStreaming: true,
      paidFromCredits: model.source === 'dorkos-credits',
    },
  ];
}

/** Build an engine descriptor using explicit metadata and a lazy credential callback. */
export function resolveDoeModel(
  input: DoeInferenceConfig,
  credentials: ModelDescriptor['credentials']
): ModelDescriptor {
  const config = DoeInferenceConfigSchema.parse(input);
  return {
    protocol: doeProtocol(config.protocol),
    endpoint: config.endpoint,
    id: config.model,
    contextWindow: config.contextWindow,
    maxOutputTokens: config.maxOutputTokens,
    payer: config.source,
    historyFamily: doeHistoryFamily(config),
    credentials,
    requiresCredentials: config.source !== 'local',
  };
}
