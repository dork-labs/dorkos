/**
 * OpenCode provider catalog → DorkOS model options.
 *
 * OpenCode's `GET /provider` is the open-source-model surface: it lists every
 * configured provider (Anthropic, OpenAI, Ollama, OpenAI-compatible local
 * endpoints, …) with its models, which providers are actually connected, and
 * each provider's default model. Options encode the pair as
 * `provider/model` — OpenCode's own CLI convention — which
 * `parseModelSelection` splits back for `session.promptAsync`.
 *
 * @module services/runtimes/opencode/models
 */
import type { ProviderListResponse } from '@opencode-ai/sdk';
import type { ModelOption } from '@dorkos/shared/types';

/**
 * Project the provider catalog onto the DorkOS model-picker shape.
 *
 * Only connected providers are offered (when OpenCode reports none connected,
 * the full catalog is shown rather than an empty picker — e.g. credentials
 * supplied through provider env vars). Deprecated models are dropped;
 * `isDefault` marks the first connected provider's default model so the
 * picker has exactly one.
 *
 * @param payload - The `provider.list` response body
 */
export function projectModelOptions(payload: ProviderListResponse): ModelOption[] {
  const connected = new Set(payload.connected);
  const providers =
    connected.size === 0 ? payload.all : payload.all.filter((entry) => connected.has(entry.id));

  const defaultProvider = providers.find((entry) => payload.default[entry.id] !== undefined);
  const options: ModelOption[] = [];
  for (const provider of providers) {
    for (const model of Object.values(provider.models)) {
      if (model.status === 'deprecated') continue;
      const isDefault =
        provider.id === defaultProvider?.id && payload.default[provider.id] === model.id;
      options.push({
        value: `${provider.id}/${model.id}`,
        displayName: model.name,
        // Provider context in the label surface (the shape has no provider
        // column beyond the id, so the description carries the human name).
        description: `${provider.name} · ${model.id}`,
        ...(isDefault ? { isDefault: true } : {}),
        contextWindow: model.limit.context,
        maxOutputTokens: model.limit.output,
        provider: provider.id,
      });
    }
  }
  return options;
}
