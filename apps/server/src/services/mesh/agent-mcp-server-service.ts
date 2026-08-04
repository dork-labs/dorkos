/**
 * Runtime-neutral CRUD + injection resolver for an agent's managed MCP servers.
 *
 * This service is the single source of truth for the `mcp.*` management verbs
 * (spec `mcp-server-management` §2). It owns every read and write of
 * {@link AgentManifest.mcpServers}, keyed by agent id, resolving an id to its
 * workspace path through an injected {@link AgentWorkspaceLocator} and
 * persisting through `readManifest`/`writeManifest` (`@dorkos/shared/manifest`).
 * The manifest file is the source of truth — `mcpServers` has no DB column and
 * is excluded from the mesh reconciler's diff (ADR 260803-233420).
 *
 * It is deliberately runtime-neutral: it never imports a runtime SDK
 * (`@anthropic-ai/claude-agent-sdk` and friends). {@link injectableServersForCwd}
 * returns the neutral {@link McpAppServerConnection} shape; the claude-code
 * adapter converts that to its own SDK config at injection time.
 *
 * @module services/mesh/agent-mcp-server-service
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { readManifest, writeManifest, MANIFEST_DIR, MANIFEST_FILE } from '@dorkos/shared/manifest';
import { AgentManifestSchema } from '@dorkos/shared/mesh-schemas';
import type { ManagedMcpServer, McpServerTransport } from '@dorkos/shared/mesh-schemas';
import type { McpAppServerConnection } from '@dorkos/shared/agent-runtime';
import type { Logger } from '@dorkos/shared/logger';

/** The DorkOS tool server's own name — reserved so a managed server can never shadow it. */
export const RESERVED_MCP_SERVER_NAME = 'dorkos';

/** Wall-clock cap on the connect + list-tools round trip in {@link AgentMcpServerService.test}. */
const TEST_PROBE_TIMEOUT_MS = 10_000;

/** Typed failure codes so a route/capability layer can map to precise statuses. */
export type AgentMcpServerErrorCode =
  | 'AGENT_NOT_FOUND'
  | 'MANIFEST_UNREADABLE'
  | 'RESERVED_NAME'
  | 'DUPLICATE_NAME'
  | 'SERVER_NOT_FOUND';

/** Error thrown by {@link AgentMcpServerService}; `code` drives the caller's status mapping. */
export class AgentMcpServerError extends Error {
  constructor(
    readonly code: AgentMcpServerErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'AgentMcpServerError';
  }
}

/**
 * Narrow port for resolving an agent id to its workspace path. The mesh
 * `AgentRegistry` (and `MeshCore`) satisfy this structurally via `get(id)`; the
 * service depends on this minimal shape rather than the whole registry so it
 * stays trivially testable.
 */
export interface AgentWorkspaceLocator {
  /** Resolve an agent id to a record carrying its absolute `projectPath`, or `undefined`. */
  get(agentId: string): { projectPath: string } | undefined;
}

/** Constructor dependencies for {@link AgentMcpServerService}. */
export interface AgentMcpServerServiceDeps {
  /** Resolves an agent id to its workspace path. */
  agents: AgentWorkspaceLocator;
  /** Diagnostic sink; defaults to `console`. */
  logger?: Pick<Logger, 'warn'>;
}

/** Arguments for {@link AgentMcpServerService.add}. */
export interface AddManagedServerOptions {
  /** Agent id whose manifest gains the server. */
  agentId: string;
  /** Server name — unique within the agent, not the reserved `dorkos`. */
  name: string;
  /** How to reach the server (stdio/http/sse). */
  connection: McpServerTransport;
  /** Who approved the add — recorded on the entry for audit. */
  addedBy: string;
  /** Whether the server is enabled on add. `add` enables by default (spec §4). */
  enabled?: boolean;
}

/** Arguments for {@link AgentMcpServerService.update}. */
export interface UpdateManagedServerOptions {
  /** Agent id whose manifest holds the server. */
  agentId: string;
  /** Name of the existing server to update. */
  name: string;
  /** Replacement connection. Omit to leave the connection unchanged. */
  connection?: McpServerTransport;
  /** New enabled state. Omit to leave it unchanged. */
  enabled?: boolean;
}

interface InjectionCacheEntry {
  mtimeMs: number;
  servers: Record<string, McpAppServerConnection>;
}

/**
 * Manages the `mcpServers` list on an agent's manifest and resolves the enabled
 * subset for inline session injection. See the module doc for the trust and
 * persistence model.
 */
export class AgentMcpServerService {
  private readonly agents: AgentWorkspaceLocator;
  private readonly logger: Pick<Logger, 'warn'>;
  /** cwd → last-seen manifest mtime + resolved enabled servers, for {@link injectableServersForCwd}. */
  private readonly injectionCache = new Map<string, InjectionCacheEntry>();

  constructor(deps: AgentMcpServerServiceDeps) {
    this.agents = deps.agents;
    this.logger = deps.logger ?? console;
  }

  /**
   * List every managed server declared on an agent's manifest.
   *
   * @param agentId - The agent's id.
   * @returns The manifest's `mcpServers` array (empty when none).
   */
  async list(agentId: string): Promise<ManagedMcpServer[]> {
    const { manifest } = await this.load(agentId);
    return manifest.mcpServers;
  }

  /**
   * Add a managed server to an agent and persist the manifest.
   *
   * Rejects the reserved name `dorkos` (which the injection order reserves for
   * the DorkOS tool server) and any name already present on the agent. Enables
   * the server by default — an add is an explicit, gated action (spec §4).
   *
   * @param opts - The agent id, server name, connection, approver, and optional enabled flag.
   * @returns The updated `mcpServers` list.
   * @throws {AgentMcpServerError} `RESERVED_NAME` or `DUPLICATE_NAME`.
   */
  async add(opts: AddManagedServerOptions): Promise<ManagedMcpServer[]> {
    const { projectPath, manifest } = await this.load(opts.agentId);
    this.assertNameAvailable(manifest.mcpServers, opts.name);

    const entry: ManagedMcpServer = {
      name: opts.name,
      enabled: opts.enabled ?? true,
      connection: opts.connection,
      addedAt: new Date().toISOString(),
      addedBy: opts.addedBy,
    };
    const next = [...manifest.mcpServers, entry];
    await this.persist(projectPath, manifest, next);
    return next;
  }

  /**
   * Update an existing managed server's connection and/or enabled state.
   *
   * @param opts - The agent id, target server name, and the fields to change.
   * @returns The updated `mcpServers` list.
   * @throws {AgentMcpServerError} `SERVER_NOT_FOUND` when no entry matches `name`.
   */
  async update(opts: UpdateManagedServerOptions): Promise<ManagedMcpServer[]> {
    const { projectPath, manifest } = await this.load(opts.agentId);
    const existing = manifest.mcpServers.find((s) => s.name === opts.name);
    if (!existing) {
      throw new AgentMcpServerError(
        'SERVER_NOT_FOUND',
        `Agent ${opts.agentId} has no managed MCP server named "${opts.name}"`
      );
    }
    const updated: ManagedMcpServer = {
      ...existing,
      ...(opts.connection ? { connection: opts.connection } : {}),
      ...(opts.enabled !== undefined ? { enabled: opts.enabled } : {}),
    };
    const next = manifest.mcpServers.map((s) => (s.name === opts.name ? updated : s));
    await this.persist(projectPath, manifest, next);
    return next;
  }

  /**
   * Remove a managed server from an agent. Reversible by re-adding.
   *
   * @param agentId - The agent's id.
   * @param name - The server to remove.
   * @returns The updated `mcpServers` list.
   * @throws {AgentMcpServerError} `SERVER_NOT_FOUND` when no entry matches `name`.
   */
  async remove(agentId: string, name: string): Promise<ManagedMcpServer[]> {
    const { projectPath, manifest } = await this.load(agentId);
    const next = manifest.mcpServers.filter((s) => s.name !== name);
    if (next.length === manifest.mcpServers.length) {
      throw new AgentMcpServerError(
        'SERVER_NOT_FOUND',
        `Agent ${agentId} has no managed MCP server named "${name}"`
      );
    }
    await this.persist(projectPath, manifest, next);
    return next;
  }

  /**
   * Enable a managed server so it is injected into the agent's next session.
   *
   * @param agentId - The agent's id.
   * @param name - The server to enable.
   * @returns The updated `mcpServers` list.
   */
  async enable(agentId: string, name: string): Promise<ManagedMcpServer[]> {
    return this.setEnabled(agentId, name, true);
  }

  /**
   * Disable a managed server, removing it from future session injection while
   * keeping its (already-approved) configuration on the manifest.
   *
   * @param agentId - The agent's id.
   * @param name - The server to disable.
   * @returns The updated `mcpServers` list.
   */
  async disable(agentId: string, name: string): Promise<ManagedMcpServer[]> {
    return this.setEnabled(agentId, name, false);
  }

  /**
   * Resolve the enabled managed servers for a session's working directory,
   * mapped to the runtime-neutral {@link McpAppServerConnection} shape and keyed
   * by server name.
   *
   * The agent workspace *is* the session cwd, so this reads `<cwd>/.dork/agent.json`
   * directly rather than going through the registry — a non-agent session simply
   * has no manifest and gets `{}`. Runs on every session turn, so it is
   * synchronous (the runtime's MCP factory is sync) and memoized by manifest
   * mtime: a repeat call with an unchanged file returns the cached map without
   * touching disk beyond a `stat`.
   *
   * @param cwd - The session's working directory (the agent's workspace path).
   * @returns Enabled servers by name, or `{}` when there is no readable manifest.
   */
  injectableServersForCwd(cwd: string): Record<string, McpAppServerConnection> {
    const manifestPath = path.join(cwd, MANIFEST_DIR, MANIFEST_FILE);

    let mtimeMs: number;
    try {
      mtimeMs = statSync(manifestPath).mtimeMs;
    } catch {
      this.injectionCache.delete(cwd);
      return {};
    }

    const cached = this.injectionCache.get(cwd);
    if (cached && cached.mtimeMs === mtimeMs) return cached.servers;

    const servers = this.readEnabledServersSync(manifestPath, cwd);
    this.injectionCache.set(cwd, { mtimeMs, servers });
    return servers;
  }

  /**
   * Transiently connect to a stored managed server and report whether it is
   * reachable and how many tools it exposes.
   *
   * Bounded and safe by construction: it only ever probes a server that already
   * exists on the manifest (so it cannot run an arbitrary ad-hoc command and
   * bypass `add`'s approval gate), opens a short-lived client, lists tools once,
   * and always closes — the whole round trip is capped at
   * {@link TEST_PROBE_TIMEOUT_MS}. A failure is returned in-band, never thrown.
   *
   * @param agentId - The agent's id.
   * @param name - The existing server to probe.
   * @returns `{ ok, toolCount? }` on success, `{ ok: false, error }` otherwise.
   */
  async test(
    agentId: string,
    name: string
  ): Promise<{ ok: boolean; toolCount?: number; error?: string }> {
    const { manifest } = await this.load(agentId);
    const server = manifest.mcpServers.find((s) => s.name === name);
    if (!server) {
      throw new AgentMcpServerError(
        'SERVER_NOT_FOUND',
        `Agent ${agentId} has no managed MCP server named "${name}"`
      );
    }

    const client = new Client({ name: 'dorkos-mcp-probe', version: '1.0.0' }, { capabilities: {} });
    const transport = createProbeTransport(server.connection);
    try {
      const tools = await withTimeout(
        (async () => {
          await client.connect(transport);
          return client.listTools();
        })(),
        TEST_PROBE_TIMEOUT_MS
      );
      return { ok: true, toolCount: tools.tools.length };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      await client.close().catch(() => {});
    }
  }

  /**
   * Resolve an agent id to its workspace path and read its manifest.
   *
   * @throws {AgentMcpServerError} `AGENT_NOT_FOUND` or `MANIFEST_UNREADABLE`.
   */
  private async load(agentId: string): Promise<{ projectPath: string; manifest: ManagedManifest }> {
    const entry = this.agents.get(agentId);
    if (!entry) {
      throw new AgentMcpServerError('AGENT_NOT_FOUND', `No agent registered with id ${agentId}`);
    }
    const manifest = await readManifest(entry.projectPath, this.logger);
    if (!manifest) {
      throw new AgentMcpServerError(
        'MANIFEST_UNREADABLE',
        `Agent ${agentId} has no readable manifest at ${entry.projectPath}`
      );
    }
    return { projectPath: entry.projectPath, manifest };
  }

  /** Write the manifest with a replaced `mcpServers` list and drop the injection cache for its cwd. */
  private async persist(
    projectPath: string,
    manifest: ManagedManifest,
    mcpServers: ManagedMcpServer[]
  ): Promise<void> {
    await writeManifest(projectPath, { ...manifest, mcpServers });
    this.injectionCache.delete(projectPath);
  }

  /** Shared enable/disable body. */
  private async setEnabled(
    agentId: string,
    name: string,
    enabled: boolean
  ): Promise<ManagedMcpServer[]> {
    return this.update({ agentId, name, enabled });
  }

  /** Reject the reserved name (case-insensitive) and any duplicate within the agent. */
  private assertNameAvailable(existing: ManagedMcpServer[], name: string): void {
    if (name.toLowerCase() === RESERVED_MCP_SERVER_NAME) {
      throw new AgentMcpServerError(
        'RESERVED_NAME',
        `"${RESERVED_MCP_SERVER_NAME}" is reserved for the DorkOS tool server`
      );
    }
    if (existing.some((s) => s.name === name)) {
      throw new AgentMcpServerError(
        'DUPLICATE_NAME',
        `A managed MCP server named "${name}" already exists on this agent`
      );
    }
  }

  /** Parse the manifest synchronously and build the enabled-servers map; `{}` on any failure. */
  private readEnabledServersSync(
    manifestPath: string,
    cwd: string
  ): Record<string, McpAppServerConnection> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch (err) {
      this.logger.warn(
        `[agent-mcp] ${manifestPath} unreadable for injection: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return {};
    }

    const result = AgentManifestSchema.safeParse(parsed);
    if (!result.success) {
      this.logger.warn(
        `[agent-mcp] ${cwd} manifest failed validation for injection: ${JSON.stringify(
          result.error.issues
        )}`
      );
      return {};
    }

    const servers: Record<string, McpAppServerConnection> = {};
    for (const server of result.data.mcpServers) {
      if (server.enabled) servers[server.name] = server.connection;
    }
    return servers;
  }
}

/** A fully-parsed manifest — the object form `readManifest` returns when present. */
type ManagedManifest = NonNullable<Awaited<ReturnType<typeof readManifest>>>;

/** Build a short-lived MCP client transport for a managed server's connection. */
function createProbeTransport(connection: McpServerTransport): Transport {
  if (connection.transport === 'stdio') {
    return new StdioClientTransport({
      command: connection.command,
      args: connection.args,
      env: connection.env,
    });
  }
  if (connection.transport === 'http') {
    return new StreamableHTTPClientTransport(new URL(connection.url), {
      requestInit: { headers: connection.headers },
    });
  }
  return new SSEClientTransport(new URL(connection.url), {
    requestInit: { headers: connection.headers },
  });
}

/** Reject a promise if it does not settle within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`MCP server probe timed out after ${ms}ms`)), ms)
    ),
  ]);
}
