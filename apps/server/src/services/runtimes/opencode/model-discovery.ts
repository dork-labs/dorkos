/** Host model discovery extracted without changing its availability filters. */
import type { ProviderListResponse } from '@opencode-ai/sdk';
import type { ModelOption } from '@dorkos/shared/types';
import { canonicalDirectory } from '@dorkos/shared/canonical-directory';
import { logger, logError } from '../../../lib/logger.js';
import { unwrap, type OpenCodeClientProvider } from './sessions/session-mapper.js';
import { detectOllama } from './providers/ollama.js';
import { fetchOpenRouterCatalog, type OpenRouterCatalog } from './providers/openrouter.js';
import { projectModelOptions, projectedProviderIds } from './providers/models.js';

/** Discover host models using the existing directory and live availability filters. */
export async function discoverOpenCodeModels(
  provider: OpenCodeClientProvider,
  directory: string
): Promise<ModelOption[]> {
  try {
    const client = await provider.getClient(directory);
    const listed = unwrap(
      // Canonical, like every other directory-scoped read (DOR-695):
      // `DORKOS_DEFAULT_CWD` is taken verbatim, and on macOS a `/tmp` or
      // `/var` spelling reaches the sidecar as a directory it never stored.
      await client.provider.list({
        query: { directory: canonicalDirectory(directory) },
      }),
      'provider.list'
    );
    const [installedOllamaTags, openRouterCatalog] = await Promise.all([
      resolveInstalledOllamaTags(listed),
      resolveOpenRouterCatalog(listed),
    ]);
    return projectModelOptions(listed, { installedOllamaTags, openRouterCatalog });
  } catch (err) {
    logger.warn('[OpenCodeRuntime] provider catalog unavailable', logError(err));
    return [];
  }
}

/**
 * Installed Ollama tags for the honest-local-availability filter (spec §10),
 * or `null` to skip filtering. Probes Ollama's `/api/tags` only when an
 * ollama model can actually reach the menu ({@link projectedProviderIds} —
 * never `payload.all`, which lists every provider models.dev knows and so
 * gates nothing); an unreachable Ollama
 * (`running: false`) returns `null` so the menu degrades to the full catalog
 * rather than emptying. A reachable Ollama returns its installed tag names
 * (possibly empty — honestly no local models installed yet).
 */
async function resolveInstalledOllamaTags(payload: ProviderListResponse): Promise<string[] | null> {
  const OLLAMA_PROVIDER_ID = 'ollama';
  if (!projectedProviderIds(payload).has(OLLAMA_PROVIDER_ID)) return null;
  const status = await detectOllama();
  if (!status.running) return null;
  return status.models.map((tag) => tag.name);
}

/**
 * OpenRouter's live public model catalog for the honest-cloud-availability
 * filter, or `null` to skip it. An unreachable OpenRouter returns `null` so
 * the menu degrades to the sidecar's own (staler) catalog rather than
 * emptying — the same rule as {@link resolveInstalledOllamaTags}, for the
 * same reason.
 *
 * Gated on {@link projectedProviderIds}, NOT on `payload.all`. `all` is the
 * whole models.dev universe — hundreds of providers, openrouter always among
 * them — so a gate written against it never closes, and an Ollama-only user
 * who has never touched OpenRouter would pay a network probe (on the model
 * WRITE path, on a plane) for a provider whose models will not appear in
 * their menu at all. `projectedProviderIds` asks the question that actually
 * matters: will any openrouter model be in the list this projection returns?
 */
async function resolveOpenRouterCatalog(
  payload: ProviderListResponse
): Promise<OpenRouterCatalog | null> {
  const OPENROUTER_PROVIDER_ID = 'openrouter';
  if (!projectedProviderIds(payload).has(OPENROUTER_PROVIDER_ID)) return null;
  return fetchOpenRouterCatalog();
}
