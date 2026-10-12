/**
 * The services the DorkOS runtime can be set up for from a key alone, or from
 * a model already running on this computer (spec `one-minute-onboarding` §6.3).
 *
 * Each preset says how to reach the service (request format and endpoint) and
 * which model to start on: when the person presses Save, the server reads the
 * service's own model list with their key and picks one ({@link pickPresetModel}),
 * then stores the key. A service that says the key is bad (401, 403) stores
 * nothing; any other failed read stores the key with the preset's
 * `fallbackModel`. Nothing reaches a service before Save.
 *
 * @module services/runtimes/doe/presets
 */
import type { DoeInferenceConfig } from '@dorkos/shared/config-schema';

/** The services set up from a preset. */
export type DoePresetId = 'openai' | 'anthropic' | 'openrouter' | 'local';

/** How to reach one service, and which model to start on. */
export interface DoePreset {
  /** The service's name, as a person reads it in an error. */
  service: string;
  /** Stored as the inference's `provider`. */
  provider: string;
  /** `api-key` for a hosted service, `local` for a model on this computer. */
  source: 'api-key' | 'local';
  /** The request format the DorkOS runtime speaks to it. */
  protocol: DoeInferenceConfig['protocol'];
  /** The base the runtime sends requests to. */
  endpoint: string;
  /** Where the service lists its models. */
  modelsUrl: string;
  /** Model id prefixes to prefer, best first. Empty means the first listed. */
  preferences: readonly string[];
  /**
   * The model to start on when the service's list cannot be read but nothing
   * says the key is bad (no answer, a 404, a key allowed to call the service
   * but not to list its models). A real, current model id of the service.
   */
  fallbackModel: string;
  /** Limits used when the list does not report them. */
  limits: { contextWindow: number; maxOutputTokens: number };
}

/** Limits for a hosted model whose list says nothing about them. */
const HOSTED_LIMITS = { contextWindow: 128_000, maxOutputTokens: 8_192 };

/**
 * The presets. Anthropic's endpoint carries no `/v1`: its client appends
 * `/v1/messages` itself, while the OpenAI-shaped clients append only the path
 * after the version.
 */
export const DOE_PRESETS: Readonly<Record<DoePresetId, DoePreset>> = {
  openai: {
    service: 'OpenAI',
    provider: 'openai',
    source: 'api-key',
    protocol: 'openai-responses',
    endpoint: 'https://api.openai.com/v1',
    modelsUrl: 'https://api.openai.com/v1/models',
    preferences: ['gpt-5.5', 'gpt-5.1', 'gpt-5', 'gpt-4.1'],
    fallbackModel: 'gpt-5',
    limits: HOSTED_LIMITS,
  },
  anthropic: {
    service: 'Anthropic',
    provider: 'anthropic',
    source: 'api-key',
    protocol: 'anthropic-messages',
    endpoint: 'https://api.anthropic.com',
    modelsUrl: 'https://api.anthropic.com/v1/models',
    preferences: ['claude-sonnet', 'claude-opus', 'claude-haiku'],
    fallbackModel: 'claude-sonnet-4-5',
    limits: HOSTED_LIMITS,
  },
  openrouter: {
    service: 'OpenRouter',
    provider: 'openrouter',
    source: 'api-key',
    protocol: 'openai-chat-completions',
    endpoint: 'https://openrouter.ai/api/v1',
    modelsUrl: 'https://openrouter.ai/api/v1/models',
    preferences: ['anthropic/claude-sonnet', 'openai/gpt-5', 'google/gemini'],
    fallbackModel: 'anthropic/claude-sonnet-4.5',
    limits: HOSTED_LIMITS,
  },
  local: {
    service: 'Ollama',
    provider: 'ollama',
    source: 'local',
    protocol: 'openai-chat-completions',
    endpoint: 'http://127.0.0.1:11434/v1',
    modelsUrl: 'http://127.0.0.1:11434/v1/models',
    preferences: [],
    fallbackModel: 'llama3.2',
    limits: { contextWindow: 32_768, maxOutputTokens: 4_096 },
  },
};

/** One model as a service's list reports it. */
export interface ListedModel {
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/** The fetch this module needs. Injected, so no test reaches the network. */
export type PresetFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** The model list could not be read: the service refused, failed or was not there. */
export class PresetModelsUnreachableError extends Error {
  /**
   * Name the service that could not be read.
   *
   * @param preset - The preset whose list failed.
   * @param cause - What went wrong, kept for the log and never shown.
   */
  constructor(
    readonly preset: DoePreset,
    cause?: unknown,
    readonly status?: number
  ) {
    super(`Could not read the ${preset.service} model list`, { cause });
    this.name = 'PresetModelsUnreachableError';
  }

  /**
   * Whether the service answered that the key itself is not accepted (401 or
   * 403). Any other failure (no answer, a timeout, a 404, an empty list) says
   * nothing about the key.
   */
  get keyRefused(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** How long one list read may take. */
const LIST_TIMEOUT_MS = 8_000;

/** The headers a list read needs: the key, the way each service takes it. */
function listHeaders(preset: DoePreset, secret: string | undefined): Record<string, string> {
  if (!secret) return {};
  if (preset.protocol === 'anthropic-messages') {
    return { 'x-api-key': secret, 'anthropic-version': '2023-06-01' };
  }
  return { authorization: `Bearer ${secret}` };
}

/** A positive whole number, or `undefined`. */
function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * The models in a list answer. Every service here answers `{ data: [...] }`;
 * the size fields differ by service and are read when present.
 *
 * @param body - The parsed answer.
 */
export function parseModelList(body: unknown): ListedModel[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((raw): ListedModel[] => {
    const entry = raw as Record<string, unknown> | null;
    if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) return [];
    const topProvider = entry.top_provider as Record<string, unknown> | undefined;
    const contextWindow =
      positiveInt(entry.context_length) ??
      positiveInt(entry.context_window) ??
      positiveInt(entry.max_input_tokens);
    const maxOutputTokens =
      positiveInt(topProvider?.max_completion_tokens) ??
      positiveInt(entry.max_output_tokens) ??
      positiveInt(entry.max_tokens);
    return [{ id: entry.id, contextWindow, maxOutputTokens }];
  });
}

/**
 * Read a service's model list with the key the person saved.
 *
 * @param preset - The service.
 * @param secret - The key, or `undefined` for a local model.
 * @param fetchImpl - The fetch to use.
 * @throws {PresetModelsUnreachableError} When the list cannot be read or is empty.
 */
export async function listPresetModels(
  preset: DoePreset,
  secret: string | undefined,
  fetchImpl: PresetFetch
): Promise<ListedModel[]> {
  let models: ListedModel[];
  try {
    const res = await fetchImpl(preset.modelsUrl, {
      headers: { accept: 'application/json', ...listHeaders(preset, secret) },
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new PresetModelsUnreachableError(preset, new Error(`HTTP ${res.status}`), res.status);
    }
    models = parseModelList(await res.json());
  } catch (error) {
    if (error instanceof PresetModelsUnreachableError) throw error;
    throw new PresetModelsUnreachableError(preset, error);
  }
  if (models.length === 0) throw new PresetModelsUnreachableError(preset);
  return models;
}

/**
 * Model ids that are a special-purpose or cut-down variant (`gpt-5-mini`,
 * `gpt-4o-realtime-preview`, `text-embedding-3-small`): never the model a chat
 * should start on, so a prefix never picks one.
 */
const VARIANT_ID =
  /(^|[-_./:])(pro|nano|mini|image|audio|realtime|search|embedding|tts|transcribe)([-_./:]|$)/i;

/**
 * The model to start on. In order: a listed id equal to a preference (best
 * first); the first listed id that starts with a preference and is no
 * variant; the first listed id that is no variant; the first listed. Sizes
 * come from the list when it reports them, else the preset's limits, and the
 * output never exceeds the context.
 *
 * @param preset - The service.
 * @param models - Its list, as read.
 */
export function pickPresetModel(
  preset: DoePreset,
  models: readonly ListedModel[]
): { model: string; contextWindow: number; maxOutputTokens: number } {
  const plain = models.filter((model) => !VARIANT_ID.test(model.id));
  const exact = preset.preferences
    .map((id) => models.find((model) => model.id === id))
    .find((model) => model !== undefined);
  const prefixed = preset.preferences
    .map((prefix) => plain.find((model) => model.id.startsWith(prefix)))
    .find((model) => model !== undefined);
  const chosen = exact ?? prefixed ?? plain[0] ?? models[0];
  if (!chosen) throw new PresetModelsUnreachableError(preset);
  const contextWindow = chosen.contextWindow ?? preset.limits.contextWindow;
  const maxOutputTokens = Math.min(
    chosen.maxOutputTokens ?? preset.limits.maxOutputTokens,
    contextWindow
  );
  return { model: chosen.id, contextWindow, maxOutputTokens };
}

/**
 * The inference a preset is saved with, before the list has been read.
 *
 * @param preset - The service.
 */
export function presetInference(preset: DoePreset): DoeInferenceConfig {
  return {
    source: preset.source,
    provider: preset.provider,
    protocol: preset.protocol,
    endpoint: preset.endpoint,
    model: preset.fallbackModel,
    contextWindow: preset.limits.contextWindow,
    maxOutputTokens: preset.limits.maxOutputTokens,
  };
}
