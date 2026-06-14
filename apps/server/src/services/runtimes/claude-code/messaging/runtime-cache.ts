/**
 * SDK response cache — models, subagents, MCP status, and commands.
 *
 * Caches values received from the Claude Agent SDK during query execution
 * and exposes them via synchronous getters. Provides cache-population callbacks
 * for the message-sender pipeline. Persists the model cache to disk for fast
 * server restarts.
 *
 * @module services/runtimes/claude-code/runtime-cache
 */
import path from 'path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { query, type Query, type ModelInfo } from '@anthropic-ai/claude-agent-sdk';
import type {
  ModelOption,
  SubagentInfo,
  CommandEntry,
  CommandRegistry,
  ReloadPluginsResult,
} from '@dorkos/shared/types';
import type { McpServerEntry } from '@dorkos/shared/transport';
import type { SdkCommandEntry, MessageSenderOpts } from './message-sender.js';
import type { CommandRegistryService } from '../tooling/command-registry.js';
import { logger } from '../../../../lib/logger.js';

/** Subset of MessageSenderOpts that RuntimeCache populates. */
type CacheCallbacks = Pick<
  MessageSenderOpts,
  | 'onModelsReceived'
  | 'onMcpStatusReceived'
  | 'onCommandsReceived'
  | 'onCommandsChanged'
  | 'onSubagentsReceived'
>;

/** Disk cache format for persisted model data. */
interface ModelDiskCache {
  /** Cached model list from SDK. */
  models: ModelOption[];
  /** ISO timestamp of when models were fetched. */
  fetchedAt: string;
  /** SDK version that reported these models. */
  sdkVersion: string;
  /** Cache format version for future migrations. */
  version: 1;
}

/**
 * Extract model family from a model ID.
 *
 * @example extractFamily('claude-opus-4-6') → 'claude-opus-4'
 * @example extractFamily('claude-sonnet-4-5-20250929') → 'claude-sonnet-4'
 */
function extractFamily(value: string): string | undefined {
  // Pattern: claude-{variant}-{major}[-{minor}[-{date}]]
  const match = value.match(/^(claude-\w+-\d+)/);
  return match?.[1];
}

/** Infer model tier from the model ID. */
function inferTier(value: string): 'flagship' | 'balanced' | 'fast' | undefined {
  if (value.includes('fable')) return 'flagship';
  if (value.includes('opus')) return 'flagship';
  if (value.includes('sonnet')) return 'balanced';
  if (value.includes('haiku')) return 'fast';
  return undefined;
}

/** Map an SDK ModelInfo to a universal ModelOption. */
export function mapSdkModelToModelOption(m: {
  value: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
  [key: string]: unknown;
}): ModelOption {
  return {
    value: m.value,
    displayName: m.displayName,
    description: m.description,
    supportsEffort: m.supportsEffort,
    supportedEffortLevels: m.supportedEffortLevels as ModelOption['supportedEffortLevels'],
    supportsAdaptiveThinking: m.supportsAdaptiveThinking,
    supportsFastMode: m.supportsFastMode,
    supportsAutoMode: m.supportsAutoMode,
    contextWindow: m['contextWindow'] as number | undefined,
    maxOutputTokens: m['maxOutputTokens'] as number | undefined,
    provider: 'anthropic',
    family: extractFamily(m.value),
    tier: inferTier(m.value),
  };
}

/**
 * Caches SDK-reported metadata (models, subagents, MCP status, commands)
 * and provides merge logic for command registries. Persists model data
 * to disk at `${dorkHome}/cache/runtimes/${runtimeType}/models.json`.
 */
export class RuntimeCache {
  private cachedModels: ModelOption[] | null = null;
  private cachedSubagents = new Map<string, SubagentInfo[]>();
  private cachedMcpStatus = new Map<string, McpServerEntry[]>();
  private cachedSdkCommands = new Map<string, SdkCommandEntry[]>();
  private warmupPromise: Promise<void> | null = null;
  private readonly cachePath: string;
  private defaultCwd: string = '';
  private static readonly TTL_MS = 86_400_000; // 24 hours

  constructor(dorkHome: string, runtimeType: string = 'claude-code') {
    this.cachePath = path.join(dorkHome, 'cache', 'runtimes', runtimeType, 'models.json');
  }

  /** Set the default cwd for lazy warm-up fallback. */
  setDefaultCwd(cwd: string): void {
    this.defaultCwd = cwd;
  }

  // ---------------------------------------------------------------------------
  // Disk cache
  // ---------------------------------------------------------------------------

  /** Load models from disk cache if fresh. Returns true if loaded. */
  private loadFromDisk(): boolean {
    try {
      if (!existsSync(this.cachePath)) return false;
      const raw = readFileSync(this.cachePath, 'utf-8');
      const parsed: ModelDiskCache = JSON.parse(raw);
      if (parsed.version !== 1 || !Array.isArray(parsed.models)) return false;
      if (this.isDiskCacheStale(parsed.fetchedAt)) return false;
      this.cachedModels = parsed.models;
      logger.debug('[RuntimeCache] loaded models from disk cache', {
        count: parsed.models.length,
        fetchedAt: parsed.fetchedAt,
      });
      return true;
    } catch (err) {
      logger.debug('[RuntimeCache] disk cache read failed', { err });
      return false;
    }
  }

  /** Write current in-memory models to disk. */
  private writeToDisk(): void {
    try {
      const dir = path.dirname(this.cachePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const cache: ModelDiskCache = {
        models: this.cachedModels ?? [],
        fetchedAt: new Date().toISOString(),
        sdkVersion: 'unknown',
        version: 1,
      };
      writeFileSync(this.cachePath, JSON.stringify(cache, null, 2), 'utf-8');
      logger.debug('[RuntimeCache] wrote models to disk cache', { count: cache.models.length });
    } catch (err) {
      logger.warn('[RuntimeCache] disk cache write failed', { err });
    }
  }

  /** Check if disk cache is stale (> TTL or missing timestamp). */
  private isDiskCacheStale(fetchedAt?: string): boolean {
    if (!fetchedAt) return true;
    return Date.now() - Date.parse(fetchedAt) > RuntimeCache.TTL_MS;
  }

  // ---------------------------------------------------------------------------
  // Warm-up
  // ---------------------------------------------------------------------------

  /**
   * Warm up the model cache by creating a temporary SDK query.
   *
   * Uses a never-yielding async iterable as the prompt so the SDK subprocess
   * initializes without sending a user message. Fetches models, writes to disk,
   * then closes the query. Safe to call multiple times — deduplicates via a
   * shared promise.
   */
  async warmup(cwd: string): Promise<void> {
    if (this.warmupPromise) return this.warmupPromise;

    this.warmupPromise = (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentionally never yields
        const neverYield = (async function* () {})();
        const agentQuery = query({ prompt: neverYield, options: { cwd } });

        const models = await agentQuery.supportedModels();
        this.cachedModels = models.map(mapSdkModelToModelOption);
        this.writeToDisk();
        logger.info('[RuntimeCache] warm-up populated model cache', {
          count: this.cachedModels.length,
        });

        agentQuery.close();
      } catch (err) {
        logger.warn('[RuntimeCache] warm-up failed', { err });
      } finally {
        this.warmupPromise = null;
      }
    })();

    return this.warmupPromise;
  }

  // ---------------------------------------------------------------------------
  // Models
  // ---------------------------------------------------------------------------

  /**
   * Get available models with a multi-tier fallback:
   * memory cache → disk cache → lazy warm-up (3s timeout) → empty array.
   */
  async getSupportedModels(): Promise<ModelOption[]> {
    // 1. Memory cache (fastest)
    if (this.cachedModels) return this.cachedModels;

    // 2. Disk cache
    if (this.loadFromDisk()) return this.cachedModels!;

    // 3. Lazy warm-up with timeout
    if (this.defaultCwd) {
      try {
        await Promise.race([
          this.warmup(this.defaultCwd),
          new Promise((_, reject) => setTimeout(() => reject(new Error('warmup timeout')), 3000)),
        ]);
        if (this.cachedModels) return this.cachedModels;
      } catch {
        logger.debug('[RuntimeCache] lazy warm-up timed out or failed');
      }
    }

    // 4. Empty — client shows loading state
    return [];
  }

  /**
   * Synchronously look up a single cached model by its identifier.
   *
   * Reads only the in-memory cache (falling back to the disk cache); never triggers
   * a warm-up, so it is safe to call on the hot send path without blocking. Returns
   * undefined when the value is unset or the model cache has not been populated yet —
   * callers should treat that as "unknown capabilities" and fall back to SDK defaults.
   *
   * @param value - The model identifier (e.g. `claude-opus-4-8`).
   */
  getCachedModel(value: string | undefined): ModelOption | undefined {
    if (!value) return undefined;
    if (!this.cachedModels) this.loadFromDisk();
    return this.cachedModels?.find((m) => m.value === value);
  }

  /**
   * Resolve the capability-bearing model entry for a session's selected model.
   *
   * The SDK reports capabilities on *alias* entries (`default`, `sonnet`, `haiku`, …),
   * not full model IDs. So:
   * - An unset model resolves to the `default` alias — its capabilities reflect the
   *   model that an unset selection actually runs (e.g. Opus 4.8). This is the common
   *   case and the one that needs the omitted-thinking fix most.
   * - An explicitly-selected alias resolves to its own entry.
   * - An explicitly-set but unknown value resolves to undefined (the caller falls back
   *   to SDK defaults) rather than borrowing the default's capabilities, which could be
   *   wrong — e.g. forcing adaptive thinking onto a non-adaptive model would 400.
   *
   * @param model - The session's selected model value, if any.
   */
  resolveModelCapability(model: string | undefined): ModelOption | undefined {
    return this.getCachedModel(model ?? 'default');
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
   * Whether SDK-reported commands are cached for a project path. False until
   * the first query for that cwd completes — built-in commands (e.g. /compact)
   * are unknowable before then, so slash-command verification must not reject
   * unrecognized names while this is false (DOR-107).
   */
  hasSdkCommands(cwd: string): boolean {
    return this.cachedSdkCommands.has(cwd);
  }

  /**
   * Replace the cached SDK commands for a cwd wholesale. Called when the SDK
   * pushes a mid-session `commands_changed` message (e.g. after a plugin
   * reload): the SDK docs say clients should REPLACE the cached list, not merge,
   * so `getCommands`/`GET /api/commands` reflect dynamically (un)registered
   * commands without a server restart (DOR-108).
   *
   * @param cwd - Project directory whose command cache to replace.
   * @param commands - The authoritative full command list from the push.
   */
  replaceSdkCommands(cwd: string, commands: SdkCommandEntry[]): void {
    this.cachedSdkCommands.set(cwd, commands);
    logger.debug('[RuntimeCache] replaced supported commands (commands_changed)', {
      cwd,
      count: commands.length,
    });
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
      ...(c.aliases && c.aliases.length > 0 ? { aliases: c.aliases } : {}),
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
   * Models always refresh (no first-call guard) and write to disk.
   */
  buildSendCallbacks(cwdKey: string): CacheCallbacks {
    return {
      onModelsReceived: (models) => {
        this.cachedModels = models.map(mapSdkModelToModelOption);
        this.writeToDisk();
        logger.debug('[sendMessage] refreshed model cache', { count: models.length });
      },
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
      // Unguarded (fires every turn): a `commands_changed` push REPLACES the
      // cached list so /api/commands stays fresh after a mid-session change.
      onCommandsChanged: (commands) => this.replaceSdkCommands(cwdKey, commands),
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
        aliases: c.aliases,
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
