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
import { capLocalTier, classifyTier, sortModelOptions } from './model-tiers.js';

/** Provider id whose models run locally on this machine (Ollama), so nothing typed leaves it. */
const LOCAL_PROVIDER_ID = 'ollama';

/** One provider entry from the OpenCode provider catalog. */
type CatalogProvider = ProviderListResponse['all'][number];

/** One model entry from a provider's catalog (the fields the projection reads). */
type CatalogModel = CatalogProvider['models'][string];

/** Inputs that shape the projection beyond the raw catalog. */
export interface ProjectModelOptionsInput {
  /**
   * Installed Ollama tags, from Ollama's `/api/tags` (spec §10 — honest local
   * availability). When provided, the ollama provider's catalog is intersected
   * with these tags so the menu offers only models actually on disk: catalog
   * metadata wins on a tag match, and installed tags absent from the catalog are
   * appended as plain options (a custom pull). `null`/omitted means "do not
   * filter" — the tags probe was unavailable, so the full catalog is shown
   * rather than an empty menu (an optimistic menu beats an empty one).
   */
  installedOllamaTags?: readonly string[] | null;
}

/** All the inputs {@link buildModelOption} needs (>4 fields → options object). */
interface ModelOptionInput {
  providerId: string;
  providerName: string;
  modelId: string;
  displayName: string;
  isDefault: boolean;
  isLocal: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/**
 * Build one DorkOS model option, tagging its capability tier (capped below
 * frontier for local models — frontier is cloud-only) and `local` flag.
 */
function buildModelOption(input: ModelOptionInput): ModelOption {
  const text = `${input.providerId}/${input.modelId} ${input.displayName}`;
  const baseTier = classifyTier(text);
  // Local models are capped below frontier — a local model whose id matches a
  // frontier family must not be badged frontier (frontier stays cloud-only).
  const tier = input.isLocal ? capLocalTier(text, baseTier) : baseTier;
  return {
    value: `${input.providerId}/${input.modelId}`,
    displayName: input.displayName,
    // Provider context in the label surface (the shape has no provider column
    // beyond the id, so the description carries the human name).
    description: `${input.providerName} · ${input.modelId}`,
    ...(input.isDefault ? { isDefault: true } : {}),
    ...(tier ? { tier } : {}),
    ...(input.isLocal ? { local: true } : {}),
    ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    provider: input.providerId,
  };
}

/** Whether a catalog model is the picker's single default (its provider's default model). */
function isDefaultModel(
  provider: CatalogProvider,
  model: CatalogModel,
  payload: ProviderListResponse,
  defaultProviderId: string | undefined
): boolean {
  return provider.id === defaultProviderId && payload.default[provider.id] === model.id;
}

/** Project one non-local catalog model, dropping deprecated ones. */
function projectCloudModel(
  provider: CatalogProvider,
  model: CatalogModel,
  payload: ProviderListResponse,
  defaultProviderId: string | undefined
): ModelOption | null {
  if (model.status === 'deprecated') return null;
  return buildModelOption({
    providerId: provider.id,
    providerName: provider.name,
    modelId: model.id,
    displayName: model.name,
    isDefault: isDefaultModel(provider, model, payload, defaultProviderId),
    isLocal: false,
    contextWindow: model.limit.context,
    maxOutputTokens: model.limit.output,
  });
}

/**
 * Project the ollama provider's models, honestly filtered to what is installed
 * (spec §10). With `installedTags` present: keep catalog models whose tag is
 * installed (catalog metadata wins), then append installed tags missing from the
 * catalog as plain options (a custom pull — displayName is the tag itself).
 * With `installedTags` null the full catalog is projected (the pre-fix behavior),
 * so an unreachable tags probe degrades to an optimistic menu rather than an
 * empty one.
 */
function projectOllamaModels(
  provider: CatalogProvider,
  payload: ProviderListResponse,
  defaultProviderId: string | undefined,
  installedTags: readonly string[] | null | undefined
): ModelOption[] {
  const options: ModelOption[] = [];
  const catalogIds = new Set<string>();

  for (const model of Object.values(provider.models)) {
    if (model.status === 'deprecated') continue;
    catalogIds.add(model.id);
    // Ollama catalog model ids ARE the full Ollama tag (e.g. `qwen2.5-coder:7b`),
    // matching `/api/tags` names 1:1 — an exact tag match is the intersection.
    if (installedTags != null && !installedTags.includes(model.id)) continue;
    options.push({
      ...buildModelOption({
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
        displayName: model.name,
        isDefault: isDefaultModel(provider, model, payload, defaultProviderId),
        isLocal: true,
        contextWindow: model.limit.context,
        maxOutputTokens: model.limit.output,
      }),
    });
  }

  if (installedTags != null) {
    for (const tag of installedTags) {
      if (catalogIds.has(tag)) continue;
      options.push(
        buildModelOption({
          providerId: provider.id,
          providerName: provider.name,
          modelId: tag,
          displayName: tag,
          isDefault: false,
          isLocal: true,
        })
      );
    }
  }

  return options;
}

/**
 * Project the provider catalog onto the DorkOS model-picker shape.
 *
 * Only connected providers are offered (when OpenCode reports none connected,
 * the full catalog is shown rather than an empty picker — e.g. credentials
 * supplied through provider env vars). Deprecated models are dropped;
 * `isDefault` marks the first connected provider's default model so the
 * picker has exactly one.
 *
 * Each option is tagged with a coarse capability {@link ModelOption.tier} and,
 * for Ollama-provider models, `local: true`; the list is returned in the
 * picker's reading order (Frontier → Solid coders → Quick helpers → untiered).
 * For the ollama provider, `installedOllamaTags` filters the catalog to models
 * actually installed (spec §10) — the projection stays pure and injectable so it
 * is unit-testable with fixed tags.
 *
 * @param payload - The `provider.list` response body.
 * @param input - Projection inputs (installed Ollama tags for the local filter).
 */
export function projectModelOptions(
  payload: ProviderListResponse,
  input: ProjectModelOptionsInput = {}
): ModelOption[] {
  const connected = new Set(payload.connected);
  const providers =
    connected.size === 0 ? payload.all : payload.all.filter((entry) => connected.has(entry.id));

  const defaultProviderId = providers.find((entry) => payload.default[entry.id] !== undefined)?.id;
  const options: ModelOption[] = [];
  for (const provider of providers) {
    if (provider.id === LOCAL_PROVIDER_ID) {
      options.push(
        ...projectOllamaModels(provider, payload, defaultProviderId, input.installedOllamaTags)
      );
      continue;
    }
    for (const model of Object.values(provider.models)) {
      const option = projectCloudModel(provider, model, payload, defaultProviderId);
      if (option) options.push(option);
    }
  }
  return sortModelOptions(options);
}
