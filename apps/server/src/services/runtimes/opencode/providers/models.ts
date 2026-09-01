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
 * ## Badge, do not hide (DOR-1660)
 *
 * The catalog is full of models that cannot do the job a DorkOS session asks of
 * them: ~23% of OpenRouter's list cannot call a tool at all, and a handful
 * answer with pictures instead of text. The projection reports both facts
 * ({@link ModelOption.supportsToolUse}, {@link ModelOption.supportsImageOutput})
 * and leaves the models in the menu, rather than dropping them. Three reasons:
 *
 * 1. **A dropped model is a model the person cannot find.** The case that
 *    started this work is someone deliberately picking an image model; hiding
 *    it answers "why did it fail?" with "where did it go?".
 * 2. **The capability metadata is not certain enough to delete on.** It comes
 *    from models.dev, which lags what a provider actually serves, so a hard
 *    drop would sometimes remove a model that works.
 * 3. **Honesty beats concealment.** The picker groups the unusable ones under
 *    their own heading and says why, so the answer arrives BEFORE the click —
 *    which is what the complaint asked for.
 *
 * The one thing that IS dropped is a model OpenRouter no longer serves at all
 * (below): that is not a capability judgement, it is a model that does not
 * exist, and offering it can only fail.
 *
 * @module services/runtimes/opencode/providers/models
 */
import type { ProviderListResponse } from '@opencode-ai/sdk';
import type { ModelOption } from '@dorkos/shared/types';
import { capLocalTier, classifyTier, sortModelOptions } from './model-tiers.js';
import type { OpenRouterCatalog } from './openrouter.js';

/** Provider id whose models run locally on this machine (Ollama), so nothing typed leaves it. */
const LOCAL_PROVIDER_ID = 'ollama';

/** Provider id whose catalog is checked against OpenRouter's live public model list. */
const OPENROUTER_PROVIDER_ID = 'openrouter';

/**
 * Cap on the optimistic menu shown when OpenCode reports NO connected provider.
 *
 * That state means the sidecar resolved no credentials (a missing
 * `OPENROUTER_API_KEY` at spawn is the common cause), and the whole models.dev
 * universe — thousands of models across hundreds of providers — is all it can
 * offer. Showing every one of them is worse than useless: none is verified, and
 * the list is too long to search by eye. The menu stays optimistic (an
 * unverified list beats an empty one, and provider-env-var credentials are a
 * real setup) but bounded to the highest-signal models after sorting, so the
 * Frontier/Solid/Quick groups survive and the untiered tail is cut. Someone
 * whose provider falls outside the cap is not stuck — the fix for this state is
 * connecting a provider, not scrolling.
 */
const UNCONNECTED_CATALOG_LIMIT = 200;

/**
 * The share of a provider's sidecar-known model ids that a live catalog must
 * still recognise before it is allowed to filter anything.
 *
 * The live intersection exists to delete a handful of models that genuinely
 * stopped existing (measured: 2 of 354). A response that would delete a large
 * FRACTION of the catalog is not that — it is a truncated page, a changed
 * envelope, or some other broken answer that happened to parse, and obeying it
 * would empty the menu while reporting success. So a live catalog that covers
 * less than this is distrusted wholesale and the sidecar's own catalog stands,
 * the same degradation as a probe that failed outright.
 *
 * Set far below any legitimate divergence: models.dev lags upstream by ADDING
 * ids late, which lowers nothing here, and the measured real coverage is ~99%.
 */
const LIVE_CATALOG_MIN_COVERAGE = 0.5;

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

  /**
   * OpenRouter's live public model catalog, from `GET /api/v1/models`. When
   * provided, the openrouter provider's catalog is intersected with it — ids
   * OpenRouter no longer serves are dropped (models.dev lags upstream and lists
   * models that return zero endpoints) — and each surviving model's
   * capabilities are taken from the live entry, which is fresher than the
   * sidecar's. `null`/omitted means "do not filter": the probe was unavailable,
   * so the full catalog is shown with models.dev's own capability metadata
   * rather than an empty menu. Same degradation rule as
   * {@link installedOllamaTags}, for the same reason.
   */
  openRouterCatalog?: OpenRouterCatalog | null;
}

/**
 * What a model can do, as far as the catalog knows. Every field is tri-state:
 * `undefined` means "not reported", which consumers must read as unknown and
 * treat optimistically — never as `false`.
 */
interface ModelCapabilities {
  /** Whether the model can call tools (agent work is impossible without it). */
  supportsToolUse?: boolean;
  /** Whether the model accepts images as input. */
  supportsVision?: boolean;
  /** Whether the model answers with generated images rather than only text. */
  supportsImageOutput?: boolean;
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
  capabilities?: ModelCapabilities;
}

/**
 * What the SIDECAR says a model can do, read off the `GET /provider` entry.
 *
 * `tool_call` is typed as required by the SDK but is absent from some providers'
 * models.dev rows, so it is read defensively: only an actual boolean is a claim,
 * anything else stays unreported rather than defaulting to `false`.
 * `modalities` is optional outright.
 *
 * @param model - One model entry from a provider's catalog.
 */
function sidecarCapabilities(model: CatalogModel): ModelCapabilities {
  const modalities = model.modalities;
  return {
    ...(typeof model.tool_call === 'boolean' ? { supportsToolUse: model.tool_call } : {}),
    ...(modalities?.input ? { supportsVision: modalities.input.includes('image') } : {}),
    ...(modalities?.output ? { supportsImageOutput: modalities.output.includes('image') } : {}),
  };
}

/**
 * Build one DorkOS model option, tagging its capability tier (capped below
 * frontier for local models — frontier is cloud-only), its `local` flag, and
 * whatever the catalog reports about what it can do.
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
    ...input.capabilities,
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

/**
 * Whether a fetched live catalog is trustworthy enough to filter this provider.
 *
 * Answers one question: of the model ids the sidecar believes this provider
 * serves, how many does the live catalog still recognise? A healthy response
 * recognises nearly all of them. A broken one — truncated, re-shaped, a page
 * instead of the whole list — recognises few, and acting on it would delete
 * most of the menu and cache that as a success.
 *
 * @param provider - The provider entry being projected.
 * @param catalog - The live catalog, or `null`/`undefined` when none was fetched.
 * @returns `false` when the catalog must be ignored for this provider.
 */
function liveCatalogCoversProvider(
  provider: CatalogProvider,
  catalog: OpenRouterCatalog | null | undefined
): boolean {
  if (catalog == null) return false;
  const known = Object.values(provider.models).filter((m) => m.status !== 'deprecated');
  if (known.length === 0) return false;
  const recognised = known.filter((m) => catalog.has(m.id)).length;
  return recognised / known.length >= LIVE_CATALOG_MIN_COVERAGE;
}

/**
 * Project one non-local catalog model, dropping deprecated ones.
 *
 * For the openrouter provider a live catalog, when one was fetched and trusted
 * ({@link liveCatalogCoversProvider}), overrules the sidecar on the two
 * questions it can answer better: whether the model still exists (an id
 * OpenRouter no longer serves is dropped — offering it can only fail) and what
 * it can do (live `supported_parameters` / `architecture` beat models.dev's
 * snapshot). Without a live catalog the sidecar's own metadata stands and
 * nothing is dropped.
 *
 * The overrule is a MERGE, not a replacement. Both sides are tri-state, and a
 * live answer of "I did not say" must leave the sidecar's answer standing — if
 * absence overwrote knowledge with `false`, one renamed field upstream would
 * mark every OpenRouter model unable to do agent work.
 */
function projectCloudModel(
  provider: CatalogProvider,
  model: CatalogModel,
  payload: ProviderListResponse,
  defaultProviderId: string | undefined,
  openRouterCatalog: OpenRouterCatalog | null | undefined
): ModelOption | null {
  if (model.status === 'deprecated') return null;
  let capabilities = sidecarCapabilities(model);
  if (provider.id === OPENROUTER_PROVIDER_ID && openRouterCatalog != null) {
    const live = openRouterCatalog.get(model.id);
    if (!live) return null;
    capabilities = {
      ...capabilities,
      ...(live.supportsTools !== undefined ? { supportsToolUse: live.supportsTools } : {}),
      ...(live.supportsVision !== undefined ? { supportsVision: live.supportsVision } : {}),
      ...(live.supportsImageOutput !== undefined
        ? { supportsImageOutput: live.supportsImageOutput }
        : {}),
    };
  }
  return buildModelOption({
    providerId: provider.id,
    providerName: provider.name,
    modelId: model.id,
    displayName: model.name,
    isDefault: isDefaultModel(provider, model, payload, defaultProviderId),
    isLocal: false,
    contextWindow: model.limit.context,
    maxOutputTokens: model.limit.output,
    capabilities,
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
        capabilities: sidecarCapabilities(model),
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
 * Mark one option as belonging to the unverified, shortened menu.
 *
 * The flag is what lets the picker stop lying by omission. Two things go wrong
 * without it, and both are the bug this work exists to fix pointed backwards:
 * the list has been cut and nothing says so, and — worse — the picker's search
 * box filters the CUT list, so typing the name of a model that really is in the
 * catalog returns a confident "No models match". A row that admits it is
 * unverified lets the menu say "shortened and unconfirmed" instead.
 *
 * @param option - The projected option to mark.
 */
function markUnverified(option: ModelOption): ModelOption {
  return { ...option, unverified: true };
}

/**
 * The provider ids whose models this payload will actually put in the menu.
 *
 * The one source of truth for that question, shared by the projection below and
 * by the runtime's probe gates. It exists because the obvious spelling is
 * wrong: `payload.all` is the entire models.dev universe, so "is provider X in
 * `all`?" is true for essentially every provider that has ever existed and
 * gates nothing. What decides the menu is `connected` — or, when nothing is
 * connected, the bounded optimistic fallback, which does draw from everything.
 *
 * @param payload - The `provider.list` response body.
 */
export function projectedProviderIds(payload: ProviderListResponse): ReadonlySet<string> {
  const connected = new Set(payload.connected);
  return connected.size === 0 ? new Set(payload.all.map((entry) => entry.id)) : connected;
}

/**
 * Bound the unverified, nothing-connected menu to
 * {@link UNCONNECTED_CATALOG_LIMIT} options, otherwise keeping the sorted order.
 *
 * The provider default always survives, wherever it sorted: the picker's
 * contract is that it has exactly one default, and a cap that silently removed
 * it would leave the person with a menu that pre-selects nothing. A default
 * rescued from beyond the cap is moved to the FRONT rather than back into its
 * sorted slot — in this state the sort is over models nothing has verified
 * anyway, and the one option the picker will pre-select should be the one the
 * person can see without scrolling.
 *
 * @param sorted - Options already in the picker's reading order.
 */
function capUnverifiedCatalog(sorted: ModelOption[]): ModelOption[] {
  if (sorted.length <= UNCONNECTED_CATALOG_LIMIT) return sorted;
  const kept = sorted.slice(0, UNCONNECTED_CATALOG_LIMIT);
  if (kept.some((option) => option.isDefault)) return kept;
  const fallbackDefault = sorted.find((option) => option.isDefault);
  if (!fallbackDefault) return kept;
  return [fallbackDefault, ...kept.slice(0, UNCONNECTED_CATALOG_LIMIT - 1)];
}

/**
 * Project the provider catalog onto the DorkOS model-picker shape.
 *
 * Only connected providers are offered. When OpenCode reports none connected, a
 * bounded slice of the full catalog is shown rather than an empty picker (e.g.
 * credentials supplied through provider env vars) — see
 * {@link UNCONNECTED_CATALOG_LIMIT} for why it is bounded. Deprecated models are
 * dropped; `isDefault` marks the first connected provider's default model so the
 * picker has exactly one.
 *
 * Each option is tagged with a coarse capability {@link ModelOption.tier}, with
 * whatever the catalog reports about what it can do
 * ({@link ModelOption.supportsToolUse}, {@link ModelOption.supportsVision},
 * {@link ModelOption.supportsImageOutput}) and, for Ollama-provider models,
 * `local: true`; the list is returned in the picker's reading order (Frontier →
 * Solid coders → Quick helpers → untiered). For the ollama provider,
 * `installedOllamaTags` filters the catalog to models actually installed (spec
 * §10); for the openrouter provider, `openRouterCatalog` intersects it with
 * what OpenRouter actually serves. The projection stays pure and injectable so
 * it is unit-testable with fixed inputs.
 *
 * @param payload - The `provider.list` response body.
 * @param input - Projection inputs (the installed-Ollama and live-OpenRouter probes).
 */
export function projectModelOptions(
  payload: ProviderListResponse,
  input: ProjectModelOptionsInput = {}
): ModelOption[] {
  const nothingConnected = payload.connected.length === 0;
  const projected = projectedProviderIds(payload);
  const providers = payload.all.filter((entry) => projected.has(entry.id));

  const defaultProviderId = providers.find((entry) => payload.default[entry.id] !== undefined)?.id;
  const options: ModelOption[] = [];
  for (const provider of providers) {
    if (provider.id === LOCAL_PROVIDER_ID) {
      options.push(
        ...projectOllamaModels(provider, payload, defaultProviderId, input.installedOllamaTags)
      );
      continue;
    }
    // Decided ONCE per provider, not per model: the floor is a judgement about
    // the response as a whole, and asking it per model would let a broken
    // catalog delete ids one at a time without ever tripping it.
    const liveCatalog = liveCatalogCoversProvider(provider, input.openRouterCatalog)
      ? input.openRouterCatalog
      : null;
    for (const model of Object.values(provider.models)) {
      const option = projectCloudModel(provider, model, payload, defaultProviderId, liveCatalog);
      if (option) options.push(option);
    }
  }
  const sorted = sortModelOptions(options);
  return nothingConnected ? capUnverifiedCatalog(sorted).map(markUnverified) : sorted;
}
