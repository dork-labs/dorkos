/**
 * SDK response cache — models, subagents, MCP status, and commands.
 *
 * Caches values received from the Claude Agent SDK during query execution
 * and exposes them via synchronous getters. Provides cache-population callbacks
 * for the message-sender pipeline.
 *
 * @module services/runtimes/claude-code/runtime-cache
 */
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type {
  ModelOption,
  SubagentInfo,
  CommandEntry,
  CommandRegistry,
  ReloadPluginsResult,
} from '@dorkos/shared/types';
import type { McpServerEntry } from '@dorkos/shared/transport';
import type { SdkCommandEntry, MessageSenderOpts } from './message-sender.js';
import type { CommandRegistryService } from './command-registry.js';
import { DEFAULT_MODELS } from './runtime-constants.js';
import { logger } from '../../../lib/logger.js';

/** Subset of MessageSenderOpts that RuntimeCache populates. */
type CacheCallbacks = Pick<
  MessageSenderOpts,
  'onModelsReceived' | 'onMcpStatusReceived' | 'onCommandsReceived' | 'onSubagentsReceived'
>;

/**
 * Caches SDK-reported metadata (models, subagents, MCP status, commands)
 * and provides merge logic for command registries.
 */
export class RuntimeCache {
  private cachedModels: ModelOption[] | null = null;
  private cachedSubagents = new Map<string, SubagentInfo[]>();
  private cachedMcpStatus = new Map<string, McpServerEntry[]>();
  private cachedSdkCommands = new Map<string, SdkCommandEntry[]>();

  /** Get available models — returns SDK-reported models if cached, otherwise defaults. */
  getSupportedModels(): ModelOption[] {
    return this.cachedModels ?? DEFAULT_MODELS;
  }

  /**
   * Get available subagents — returns SDK-reported agents for a cwd if cached, otherwise empty.
   *
   * When called without cwd (e.g. from the interface that lacks a cwd parameter),
   * returns the most recently cached entry as a best-effort fallback.
   */
  getSupportedSubagents(cwd?: string): SubagentInfo[] {
    if (cwd) return this.cachedSubagents.get(cwd) ?? [];
    // Fallback: return last-inserted entry (best-effort when no cwd is available)
    let last: SubagentInfo[] | undefined;
    for (const v of this.cachedSubagents.values()) last = v;
    return last ?? [];
  }

  /** Return last-known MCP server status for a project path, or null if unavailable. */
  getMcpStatus(cwd: string): McpServerEntry[] | null {
    return this.cachedMcpStatus.get(cwd) ?? null;
  }

  /**
   * Return commands, merging SDK-reported commands with filesystem metadata.
   *
   * When SDK commands are cached for the given cwd, they are the authoritative
   * source and get enriched with filesystem metadata (allowedTools, filePath, namespace).
   * Before any SDK session for a cwd, falls back to the filesystem scanner.
   *
   * @param registry - Filesystem command scanner for the target project
   * @param cwdKey - Project directory to look up cached SDK commands
   * @param forceRefresh - Force filesystem rescan (SDK cache persists)
   */
  async getCommands(
    registry: CommandRegistryService,
    cwdKey: string,
    forceRefresh?: boolean
  ): Promise<CommandRegistry> {
    const cached = this.cachedSdkCommands.get(cwdKey);
    if (!cached) {
      return registry.getCommands(forceRefresh);
    }

    const sdkEntries: CommandEntry[] = cached.map((c) => ({
      fullCommand: c.name.startsWith('/') ? c.name : `/${c.name}`,
      description: c.description,
      argumentHint: c.argumentHint || undefined,
    }));

    // Enrich SDK commands with filesystem metadata (forceRefresh refreshes filesystem only —
    // SDK cache persists since it represents the authoritative process command list)
    const fsCommands = await registry.getCommands(forceRefresh);
    const fsLookup = new Map(fsCommands.commands.map((c) => [c.fullCommand, c]));

    // SDK returns skills (.claude/skills/) but not legacy commands (.claude/commands/).
    // Build the union: enriched SDK entries + filesystem-only entries (legacy commands).
    const sdkCommandNames = new Set(sdkEntries.map((e) => e.fullCommand));

    const enrichedSdkEntries = sdkEntries.map((entry) => {
      const fsMatch = fsLookup.get(entry.fullCommand);
      if (fsMatch) {
        return {
          ...entry,
          namespace: fsMatch.namespace,
          command: fsMatch.command,
          allowedTools: fsMatch.allowedTools,
          filePath: fsMatch.filePath,
        };
      }
      return entry;
    });

    // Include filesystem commands not returned by the SDK (e.g. legacy .claude/commands/ entries)
    const filesystemOnlyEntries = fsCommands.commands.filter(
      (c) => !sdkCommandNames.has(c.fullCommand)
    );

    const merged = [...enrichedSdkEntries, ...filesystemOnlyEntries];
    merged.sort((a, b) => a.fullCommand.localeCompare(b.fullCommand));
    return { commands: merged, lastScanned: new Date().toISOString() };
  }

  /**
   * Build cache-population callbacks for executeSdkQuery.
   *
   * Returns callback functions that update internal caches when the SDK
   * reports models, subagents, MCP status, and commands during a query.
   */
  buildSendCallbacks(cwdKey: string): CacheCallbacks {
    return {
      onModelsReceived: !this.cachedModels
        ? (models) => {
            this.cachedModels = models;
            logger.debug('[sendMessage] cached supported models', { count: models.length });
          }
        : undefined,
      onMcpStatusReceived: (servers) => {
        this.cachedMcpStatus.set(cwdKey, servers);
        logger.debug('[sendMessage] cached MCP server status', {
          cwd: cwdKey,
          count: servers.length,
        });
      },
      onCommandsReceived: !this.cachedSdkCommands.has(cwdKey)
        ? (commands) => {
            this.cachedSdkCommands.set(cwdKey, commands);
            logger.debug('[sendMessage] cached supported commands', {
              cwd: cwdKey,
              count: commands.length,
            });
          }
        : undefined,
      onSubagentsReceived: !this.cachedSubagents.has(cwdKey)
        ? (agents) => {
            this.cachedSubagents.set(cwdKey, agents);
            logger.debug('[sendMessage] cached supported subagents', {
              cwd: cwdKey,
              count: agents.length,
            });
          }
        : undefined,
    };
  }

  /**
   * Reload plugins from a query object and update all caches.
   *
   * @param queryObj - Active or last-completed SDK query
   * @param sessionCwd - Session working directory (cache key for MCP status)
   * @param defaultCwd - Fallback working directory
   */
  async reloadPlugins(
    queryObj: Query,
    sessionCwd: string | undefined,
    defaultCwd: string
  ): Promise<ReloadPluginsResult> {
    const result = await queryObj.reloadPlugins();

    const cwd = sessionCwd ?? defaultCwd;
    this.cachedSdkCommands.set(
      cwd,
      result.commands.map((c) => ({
        name: c.name,
        description: c.description,
        argumentHint: c.argumentHint,
      }))
    );
    this.cachedMcpStatus.set(
      cwd,
      result.mcpServers
        .filter((s) => s.name !== 'dorkos')
        .map((s) => ({
          name: s.name,
          type:
            s.config?.type === 'sse' || s.config?.type === 'http'
              ? s.config.type
              : ('stdio' as const),
          status: s.status,
          error: s.error,
          scope: s.scope,
        }))
    );

    if (result.agents) {
      this.cachedSubagents.set(
        cwd,
        result.agents.map((a) => ({
          name: a.name,
          description: a.description,
          model: a.model,
        }))
      );
    }

    return {
      commandCount: result.commands.length,
      pluginCount: result.plugins.length,
      errorCount: result.error_count,
    };
  }
}
