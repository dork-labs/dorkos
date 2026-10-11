import type { ModelOption, SubagentInfo, CommandRegistry } from '@dorkos/shared/types';
import type {
  AgentRegistryPort,
  RuntimeCapabilities,
  DependencyCheck,
} from '@dorkos/shared/agent-runtime';
import type { McpServerEntry } from '@dorkos/shared/transport';
import type { ConnectorRuntimeTools } from '../../connector-tools.js';
import type { CodexTransport } from '../transport/index.js';
import type { CodexModelCatalog } from '../model-catalog.js';
import type { CodexThreadMap } from '../thread-map.js';
import { CODEX_CAPABILITIES } from '../runtime-constants.js';
import { checkCodexDependencies, codexAppServerVersionNote } from '../check-dependencies.js';
import { codexAppServerPool } from '../app-server/process-pool.js';
import { PINNED_CODEX_APP_SERVER_VERSION } from '../app-server/protocol/methods.js';
import { scanSkillCommands } from '../scan-skill-commands.js';
import { dorkosToolsPosture } from '../../shared/dorkos-mcp-injection.js';
import { homeOf, resolveAgentHome, type AgentHome } from '../../../core/agent-identity/index.js';
import { enumerateCodexMcpServers } from '../enumerate-mcp-servers.js';
import { threadRunsOnCredits } from '../credits-launch.js';
import { creditsCodexHome } from '../codex-home.js';
import { readCodexTurnContextUsage } from '../turn-context-usage.js';
import type { SessionAttachmentStore } from '../../../session/attachments/index.js';

interface OriginalCodexDiscoveryView {
  readonly modelCatalog: Pick<CodexModelCatalog, 'getSupportedModels'>;
  readonly transport: CodexTransport;
  readonly attachments: SessionAttachmentStore | null;
  readonly meshCore: AgentRegistryPort | undefined;
  readonly connectorRuntimeTools: ConnectorRuntimeTools | undefined;
  readonly threadMap: CodexThreadMap;
  readonly resolveBinary: () => Promise<string | null>;
  readonly MCP_STATUS_TTL_MS: number;
  readonly CONTEXT_USAGE_AT_REST_TIMEOUT_MS: number;
  mcpStatusCache: McpServerEntry[] | null;
  mcpStatusWarmedAt: number | null;
  mcpWarmPromise: Promise<void> | null;
  readonly identityPathFor: (cwd: string, forAgent: string | undefined) => AgentHome | undefined;
  readonly maybeWarmMcpStatus: () => void;
  readonly warmMcpStatus: () => Promise<void>;
}
/** Every external factory owns unrelated discovery keys; actual registration remains runtime private. */
export function createIsolatedCodexRuntimeDiscovery() {
  const views = new WeakMap<object, OriginalCodexDiscoveryView>();
  const get = WeakMap.prototype.get;
  const set = WeakMap.prototype.set;
  const apply = Reflect.apply;
  function actual(owner: object): OriginalCodexDiscoveryView {
    const view = apply(get, views, [owner]) as OriginalCodexDiscoveryView | undefined;
    if (!view) throw new Error('Unknown original Codex discovery owner.');
    return view;
  }
  async function discoverGetSupportedModels(owner: object): Promise<ModelOption[]> {
    const facet = actual(owner);
    return facet.modelCatalog.getSupportedModels();
  }

  async function discoverGetSupportedSubagents(owner: object): Promise<SubagentInfo[]> {
    actual(owner);
    return [];
  }

  function discoverGetCapabilities(owner: object): RuntimeCapabilities {
    const facet = actual(owner);
    const overrides = facet.transport.capabilities;
    // `commandIntents` is merged per intent, so a transport that turns one on
    // does not drop the others the base declares.
    const base =
      Object.keys(overrides).length === 0
        ? CODEX_CAPABILITIES
        : {
            ...CODEX_CAPABILITIES,
            ...overrides,
            commandIntents: { ...CODEX_CAPABILITIES.commandIntents, ...overrides.commandIntents },
          };
    if (!facet.attachments) return base;
    return { ...base, mediaOutput: 'attachments' };
  }

  async function discoverCheckDependencies(owner: object): Promise<DependencyCheck[]> {
    const facet = actual(owner);
    const checks = await checkCodexDependencies();
    if (facet.transport.kind !== 'app-server') return checks;
    const note = codexAppServerVersionNote(
      codexAppServerPool.lastSeenVersion,
      PINNED_CODEX_APP_SERVER_VERSION
    );
    return note ? [...checks, note] : checks;
  }

  async function discoverGetCommands(
    owner: object,
    _forceRefresh?: boolean,
    cwd?: string
  ): Promise<CommandRegistry> {
    actual(owner);
    const commands = cwd ? scanSkillCommands(cwd) : [];
    return { commands, lastScanned: new Date().toISOString() };
  }

  function discoverGetMcpStatus(owner: object, _cwd: string): McpServerEntry[] | null {
    const facet = actual(owner);
    facet.maybeWarmMcpStatus();
    return facet.mcpStatusCache;
  }

  async function discoverCarriesRoomTools(
    owner: object,
    session: { cwd: string; agentPath?: string }
  ): Promise<boolean> {
    const facet = actual(owner);
    const agentPath = facet.identityPathFor(session.cwd, session.agentPath);
    return dorkosToolsPosture(
      agentPath && facet.meshCore?.getByPath(agentPath) ? agentPath : undefined,
      facet.connectorRuntimeTools !== undefined
    ).wired;
  }

  function discoverIdentityPathFor(
    owner: object,
    cwd: string,
    forAgent: string | undefined
  ): AgentHome | undefined {
    actual(owner);
    return homeOf(resolveAgentHome(cwd, forAgent));
  }

  function discoverMaybeWarmMcpStatus(owner: object): void {
    const facet = actual(owner);
    if (facet.mcpWarmPromise !== null) return;
    const isFresh =
      facet.mcpStatusWarmedAt !== null &&
      Date.now() - facet.mcpStatusWarmedAt < facet.MCP_STATUS_TTL_MS;
    if (isFresh) return;
    facet.mcpWarmPromise = facet.warmMcpStatus();
  }

  async function discoverWarmMcpStatus(owner: object): Promise<void> {
    const facet = actual(owner);
    try {
      const servers = await enumerateCodexMcpServers(facet.resolveBinary);
      if (servers !== null) {
        facet.mcpStatusCache = servers;
        facet.mcpStatusWarmedAt = Date.now();
      }
    } finally {
      facet.mcpWarmPromise = null;
    }
  }

  async function discoverReadContextUsage(
    owner: object,
    sessionId: string,
    _cwd: string | undefined
  ): Promise<{ contextTokens: number; contextMaxTokens: number } | null> {
    const facet = actual(owner);
    const threadId = facet.threadMap.get(sessionId)?.threadId;
    if (!threadId) return null;
    const codexHome = (await threadRunsOnCredits(threadId)) ? creditsCodexHome() : undefined;
    return readCodexTurnContextUsage({
      threadId,
      timeoutMs: facet.CONTEXT_USAGE_AT_REST_TIMEOUT_MS,
      ...(codexHome ? { codexHome } : {}),
    });
  }
  return Object.freeze({
    register(owner: object, view: OriginalCodexDiscoveryView): void {
      apply(set, views, [owner, view]);
    },
    discoverGetSupportedModels,
    discoverGetSupportedSubagents,
    discoverGetCapabilities,
    discoverCheckDependencies,
    discoverGetCommands,
    discoverGetMcpStatus,
    discoverCarriesRoomTools,
    discoverIdentityPathFor,
    discoverMaybeWarmMcpStatus,
    discoverWarmMcpStatus,
    discoverReadContextUsage,
  });
}
