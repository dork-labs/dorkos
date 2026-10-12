import { readOriginalOpenCodeRuntimeView } from './opencode-runtime.js';
import type { ProviderListResponse } from '@opencode-ai/sdk';
import type { ModelOption, SubagentInfo, CommandRegistry } from '@dorkos/shared/types';
import type { DependencyCheck } from '@dorkos/shared/agent-runtime';
import type { McpServerEntry } from '@dorkos/shared/transport';
import { DEFAULT_CWD } from '../../../lib/resolve-root.js';
import { logger, logError } from '../../../lib/logger.js';
import {
  checkOpenCodeDependencies,
  getConnectedOpenCodeProvider,
} from './providers/check-dependencies.js';
import { detectOllama } from './providers/ollama.js';
import { fetchOpenRouterCatalog, type OpenRouterCatalog } from './providers/openrouter.js';
import { unwrap } from './sessions/session-mapper.js';
import { projectModelOptions, projectedProviderIds } from './providers/models.js';
import { canonicalDirectory } from '@dorkos/shared/canonical-directory';
import { listOpenCodeSubagents } from './subagent-list.js';

/**
 * @inheritdoc
 *
 * Live from the sidecar's provider catalog — the open-source-model surface
 * (Anthropic/OpenAI/Ollama/OpenAI-compatible endpoints, whatever the user
 * configured). Boots the sidecar when needed; an unreachable sidecar yields
 * an empty picker rather than an error.
 *
 * `query.directory` is load-bearing (NOTES.md §9). `GET /provider` reads
 * `enabled_providers`/`disabled_providers` off the same per-directory config
 * `GET /config` does, and resolves the directory as
 * `query → x-opencode-directory → the SIDECAR's own process.cwd()`. Passing
 * `DEFAULT_CWD` to `getClient` does NOT carry it: that argument is accepted
 * and ignored (one shared sidecar, routed per request), and the client sets
 * no directory header. Without the query the picker is built from whatever
 * project the sidecar process happens to sit in — so a provider declared in
 * THIS project's `opencode.json` would be missing from the menu, and one
 * disabled here would still be offered.
 */
export async function getSupportedModels(runtimeOwner: object): Promise<ModelOption[]> {
  const facet = readOriginalOpenCodeRuntimeView(runtimeOwner);
  try {
    const client = await facet.provider.getClient(DEFAULT_CWD);
    const listed = unwrap(
      // Canonical, like every other directory-scoped read (DOR-695):
      // `DORKOS_DEFAULT_CWD` is taken verbatim, and on macOS a `/tmp` or
      // `/var` spelling reaches the sidecar as a directory it never stored.
      await client.provider.list({ query: { directory: canonicalDirectory(DEFAULT_CWD) } }),
      'provider.list'
    );
    const [installedOllamaTags, openRouterCatalog] = await Promise.all([
      facet.resolveInstalledOllamaTags(listed),
      facet.resolveOpenRouterCatalog(listed),
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
export async function resolveInstalledOllamaTags(
  runtimeOwner: object,
  payload: ProviderListResponse
): Promise<string[] | null> {
  readOriginalOpenCodeRuntimeView(runtimeOwner);
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
export async function resolveOpenRouterCatalog(
  runtimeOwner: object,
  payload: ProviderListResponse
): Promise<OpenRouterCatalog | null> {
  readOriginalOpenCodeRuntimeView(runtimeOwner);
  const OPENROUTER_PROVIDER_ID = 'openrouter';
  if (!projectedProviderIds(payload).has(OPENROUTER_PROVIDER_ID)) return null;
  return fetchOpenRouterCatalog();
}

/**
 * @inheritdoc
 *
 * OpenCode's auth is provider-agnostic — the connected source is DorkOS's
 * persisted `runtimes.opencode.provider`. Surfaced so the client can label a
 * "Change power source" affordance with the current source. `null` when the
 * runtime was authenticated outside DorkOS (e.g. the OpenCode CLI logged in
 * directly), so there is no DorkOS provider to switch.
 */
export function getConnectedProvider(runtimeOwner: object): string | null {
  readOriginalOpenCodeRuntimeView(runtimeOwner);
  return getConnectedOpenCodeProvider();
}

/** List Main's named subagent/all agents using this constructor-owned provider. */
export async function getSupportedSubagents(runtimeOwner: object): Promise<SubagentInfo[]> {
  const facet = readOriginalOpenCodeRuntimeView(runtimeOwner);
  return listOpenCodeSubagents(facet.provider, DEFAULT_CWD);
}

/** OpenCode exposes no DorkOS-invocable slash commands. */
export async function getCommands(runtimeOwner: object): Promise<CommandRegistry> {
  readOriginalOpenCodeRuntimeView(runtimeOwner);
  return { commands: [], lastScanned: new Date().toISOString() };
}

/**
 * @inheritdoc
 *
 * Surfaces the MCP servers OpenCode loaded for a directory from its OWN config
 * (the merged global + per-project `opencode.json` `mcp` map), read-only:
 * `supportsMcp` stays false, so these render as discovered, non-editable rows
 * in the profile's Tools & MCP roster. Delegated to {@link OpenCodeMcpManager}, which warms
 * a per-cwd cache out-of-band and peek-only (never boots the sidecar just to
 * populate a read-only roster).
 */
export function getMcpStatus(runtimeOwner: object, cwd: string): McpServerEntry[] | null {
  const facet = readOriginalOpenCodeRuntimeView(runtimeOwner);
  return facet.mcp.getStatus(cwd);
}

/**
 * Whether the `dorkos` tool server is registered on this directory's sidecar
 * right now (spec `tool-only-room-replies` §D2).
 *
 * The reconcile's own answer, not a configuration read: OpenCode surfaces a
 * name collision as a `failed` roster entry rather than overwriting a user's
 * server, and an add can simply fail, so "we are configured to inject it" and
 * "it is there" are genuinely different facts here. A room asking whether to
 * suppress a turn's words needs the second one.
 *
 * **That is also why this cannot drift from its injection gate the way codex's
 * did.** `resolveDorkosServer` withholds the entry for a directory hosting no
 * registered agent, so the name never reaches `mcp.add` and never lands in the
 * record this reads — the mesh gate is upstream of the answer rather than
 * restated beside it. There is no second reading of the gate here to keep in
 * step, which is the strongest form of the property.
 *
 * `false` until this directory has reconciled once, which keeps the first turn
 * on text-as-reply rather than betting an answer on a registration that has not
 * happened yet.
 *
 * @param session.cwd - The session's working directory, canonicalized to the
 * key used by MCP reconciliation.
 * @returns Whether the tools are reachable from a turn there.
 */
export async function carriesRoomTools(
  runtimeOwner: object,
  session: { cwd: string }
): Promise<boolean> {
  const facet = readOriginalOpenCodeRuntimeView(runtimeOwner);
  return facet.mcp.dorkosApplied(canonicalDirectory(session.cwd));
}

/** Run the original guarded checkDependencies operation. */
export async function checkDependencies(runtimeOwner: object): Promise<DependencyCheck[]> {
  readOriginalOpenCodeRuntimeView(runtimeOwner);
  return checkOpenCodeDependencies();
}
