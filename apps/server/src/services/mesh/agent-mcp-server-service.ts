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
import { readManifest, writeManifest, MANIFEST_DIR, MANIFEST_FILE } from '@dorkos/shared/manifest';
import { AgentManifestSchema, McpServerTransportSchema } from '@dorkos/shared/mesh-schemas';
import type { ManagedMcpServer, McpServerTransport } from '@dorkos/shared/mesh-schemas';
import type { McpAppServerConnection } from '@dorkos/shared/agent-runtime';
import type { Logger } from '@dorkos/shared/logger';

import { readMcpJsonServers, resolveMcpJsonConnection } from './mcp-json.js';
import {
  createProbeTransport,
  isUnauthorizedProbeError,
  withProbeTimeout,
  TEST_PROBE_TIMEOUT_MS,
} from './agent-mcp-probe.js';

/** The DorkOS tool server's own name — reserved so a managed server can never shadow it. */
export const RESERVED_MCP_SERVER_NAME = 'dorkos';

/** The HTTP header a managed-MCP OAuth access token is injected under. */
const AUTHORIZATION_HEADER = 'Authorization';

/**
 * The synchronous access-token lookup the injection path consults for managed-MCP
 * OAuth (DOR-942). Satisfied structurally by `AgentMcpOAuthService`; kept as a
 * narrow port so this runtime-neutral service never imports the OAuth engine (or,
 * through it, the MCP SDK auth module) as a value.
 */
export interface McpOAuthTokenProvider {
  /**
   * The live bearer access token for `(agentId, serverName)`, or `undefined` when
   * none is cached — in which case injection withholds the header (needs-auth).
   *
   * @param agentId - The owning agent's id.
   * @param serverName - The managed server's name.
   */
  getAccessToken(agentId: string, serverName: string): string | undefined;
}

/** Typed failure codes so a route/capability layer can map to precise statuses. */
export type AgentMcpServerErrorCode =
  | 'AGENT_NOT_FOUND'
  | 'MANIFEST_UNREADABLE'
  | 'RESERVED_NAME'
  | 'DUPLICATE_NAME'
  | 'SERVER_NOT_FOUND'
  | 'DISCOVERED_NOT_FOUND';

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
  /**
   * Synchronous OAuth access-token lookup for managed-MCP OAuth (DOR-942). When
   * present, {@link AgentMcpServerService.injectableServersForCwd} merges an
   * `Authorization: Bearer` header into an http/sse entry whenever a live token
   * exists for it, and withholds it otherwise. Omitted → no bearer injection.
   */
  tokenProvider?: McpOAuthTokenProvider;
  /**
   * `fetch` seam for the http/sse reachability probe in
   * {@link AgentMcpServerService.test} (defaults to the transport's global fetch);
   * injected by tests to simulate a 401.
   */
  probeFetch?: typeof fetch;
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

/** Arguments for {@link AgentMcpServerService.import}. */
export interface ImportManagedServerOptions {
  /** Agent id whose manifest gains the imported server. */
  agentId: string;
  /** The discovered server's name — the key under `.mcp.json`'s `mcpServers`. */
  name: string;
  /** Who approved the import — recorded on the entry for audit. */
  addedBy: string;
  /**
   * Fallback connection resolver, invoked only when the workspace `.mcp.json`
   * does not resolve the named server. Lets a runtime (claude-code) supply an
   * already-captured connection without this runtime-neutral service importing a
   * runtime SDK. A returned value is re-validated before use.
   */
  resolveFallback?: () => McpAppServerConnection | null;
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
  /** The agent id parsed from the manifest — the key half the OAuth token lookup needs. */
  agentId: string;
  /** The base enabled-servers map, parsed once per manifest mtime; bearer headers are merged live per read. */
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
  private readonly tokenProvider: McpOAuthTokenProvider | undefined;
  private readonly probeFetch: typeof fetch | undefined;
  /** cwd → last-seen manifest mtime + resolved enabled servers, for {@link injectableServersForCwd}. */
  private readonly injectionCache = new Map<string, InjectionCacheEntry>();

  constructor(deps: AgentMcpServerServiceDeps) {
    this.agents = deps.agents;
    this.logger = deps.logger ?? console;
    this.tokenProvider = deps.tokenProvider;
    this.probeFetch = deps.probeFetch;
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
   * Import a discovered (read-only) `.mcp.json` server into the managed store as
   * an enabled, editable entry (DOR-894).
   *
   * Resolution order matters, and the name checks come FIRST: the reserved name
   * `dorkos` and any name the agent already manages are rejected before the file
   * is read, so importing an already-managed name fails as `DUPLICATE_NAME`
   * rather than as a missing discovered server. It then resolves the connection
   * from the workspace `.mcp.json` (primary), falling back to
   * {@link ImportManagedServerOptions.resolveFallback} when the file cannot
   * resolve it, and throws `DISCOVERED_NOT_FOUND` when neither can. The write is
   * a normal managed `add`, so an imported server is enabled and injected like
   * any other.
   *
   * @param opts - The agent id, discovered name, approver, and optional fallback.
   * @returns The updated `mcpServers` list.
   * @throws {AgentMcpServerError} `RESERVED_NAME`, `DUPLICATE_NAME`, or
   *   `DISCOVERED_NOT_FOUND`.
   */
  async import(opts: ImportManagedServerOptions): Promise<ManagedMcpServer[]> {
    const { projectPath, manifest } = await this.load(opts.agentId);
    this.assertNameAvailable(manifest.mcpServers, opts.name);

    const connection = await this.resolveDiscoveredConnection(
      projectPath,
      opts.name,
      opts.resolveFallback
    );
    if (!connection) {
      throw new AgentMcpServerError(
        'DISCOVERED_NOT_FOUND',
        `No discovered MCP server named "${opts.name}" could be resolved from ${projectPath}/.mcp.json`
      );
    }

    const entry: ManagedMcpServer = {
      name: opts.name,
      enabled: true,
      connection,
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
   * Enable a managed server so its tools are injected on the agent's next turn.
   *
   * Injection recomposes `mcpServers` every turn on the same resumed session (the
   * claude-code factory runs per query; ADR 260803-233420), so a server enabled
   * mid-conversation is live on the next message — no restart.
   *
   * @param agentId - The agent's id.
   * @param name - The server to enable.
   * @returns The updated `mcpServers` list.
   */
  async enable(agentId: string, name: string): Promise<ManagedMcpServer[]> {
    return this.setEnabled(agentId, name, true);
  }

  /**
   * Disable a managed server, removing its tools from the next turn's injection
   * while keeping its (already-approved) configuration on the manifest.
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
   * mtime: a repeat call with an unchanged file returns the cached parse without
   * touching disk beyond a `stat`.
   *
   * The base parse is cached, but the OAuth bearer header is merged **live on
   * every read** (`mergeOAuthHeaders`), not baked into the cache — a token becomes
   * available (after sign-in) or is refreshed without the manifest mtime changing,
   * so caching the header would strand a stale one.
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
    const entry =
      cached && cached.mtimeMs === mtimeMs
        ? cached
        : this.readEnabledServersSync(manifestPath, cwd, mtimeMs);
    if (entry !== cached) this.injectionCache.set(cwd, entry);
    return this.mergeOAuthHeaders(entry.agentId, entry.servers);
  }

  /**
   * Return a per-read copy of the enabled servers with an `Authorization: Bearer`
   * header merged into each http/sse entry that has a live cached OAuth token, and
   * left untouched otherwise. The safe default is withholding: no token → no
   * header → the server reports needs-auth rather than connecting unauthenticated
   * (`.claude/rules/safe-defaults.md`). Never mutates the cached base map.
   *
   * @param agentId - The owning agent's id (the token lookup's key half).
   * @param base - The cached, header-free enabled-servers map.
   */
  private mergeOAuthHeaders(
    agentId: string,
    base: Record<string, McpAppServerConnection>
  ): Record<string, McpAppServerConnection> {
    if (!this.tokenProvider) return base;
    const out: Record<string, McpAppServerConnection> = {};
    for (const [name, connection] of Object.entries(base)) {
      // stdio servers have no remote endpoint and never take a bearer; the early
      // continue narrows `connection` to http/sse for the single header merge below.
      if (connection.transport === 'stdio') {
        out[name] = connection;
        continue;
      }
      const token = this.tokenProvider.getAccessToken(agentId, name);
      out[name] = token
        ? {
            ...connection,
            headers: { ...connection.headers, [AUTHORIZATION_HEADER]: `Bearer ${token}` },
          }
        : connection;
    }
    return out;
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
   * A 401 / unauthorized probe is classified as `needsAuth: true` (DOR-942) so the
   * client can render "Needs sign-in" instead of the raw SDK error; every other
   * failure keeps its raw message with `needsAuth` absent.
   *
   * @param agentId - The agent's id.
   * @param name - The existing server to probe.
   * @returns `{ ok, toolCount? }` on success, `{ ok: false, error, needsAuth? }` otherwise.
   */
  async test(
    agentId: string,
    name: string
  ): Promise<{ ok: boolean; toolCount?: number; error?: string; needsAuth?: boolean }> {
    const { manifest } = await this.load(agentId);
    const server = manifest.mcpServers.find((s) => s.name === name);
    if (!server) {
      throw new AgentMcpServerError(
        'SERVER_NOT_FOUND',
        `Agent ${agentId} has no managed MCP server named "${name}"`
      );
    }

    const client = new Client({ name: 'dorkos-mcp-probe', version: '1.0.0' }, { capabilities: {} });
    const transport = createProbeTransport(server.connection, this.probeFetch);
    try {
      const tools = await withProbeTimeout(
        (async () => {
          await client.connect(transport);
          return client.listTools();
        })(),
        TEST_PROBE_TIMEOUT_MS
      );
      return { ok: true, toolCount: tools.tools.length };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return isUnauthorizedProbeError(err)
        ? { ok: false, needsAuth: true, error }
        : { ok: false, error };
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

  /**
   * Resolve a discovered server's connection: the workspace `.mcp.json` first,
   * then the optional runtime fallback. A fallback value is re-validated through
   * {@link McpServerTransportSchema} so a partial runtime shape (optional
   * `args`/`env`/`headers`) lands with the schema's defaults, exactly like the
   * `.mcp.json` path.
   */
  private async resolveDiscoveredConnection(
    projectPath: string,
    name: string,
    resolveFallback?: () => McpAppServerConnection | null
  ): Promise<McpServerTransport | null> {
    const servers = await readMcpJsonServers(projectPath);
    const primary = resolveMcpJsonConnection(servers, name);
    if (primary) return primary;

    const fallback = resolveFallback?.();
    if (!fallback) return null;
    const parsed = McpServerTransportSchema.safeParse(fallback);
    return parsed.success ? parsed.data : null;
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

  /**
   * Parse the manifest synchronously into a cache entry: the manifest mtime, the
   * agent id (the token lookup's key half), and the enabled-servers map.
   * Degrades to an empty map with an empty agent id on any failure, so a bad
   * manifest injects nothing rather than throwing on the turn path.
   */
  private readEnabledServersSync(
    manifestPath: string,
    cwd: string,
    mtimeMs: number
  ): InjectionCacheEntry {
    const empty: InjectionCacheEntry = { mtimeMs, agentId: '', servers: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch (err) {
      this.logger.warn(
        `[agent-mcp] ${manifestPath} unreadable for injection: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return empty;
    }

    const result = AgentManifestSchema.safeParse(parsed);
    if (!result.success) {
      this.logger.warn(
        `[agent-mcp] ${cwd} manifest failed validation for injection: ${JSON.stringify(
          result.error.issues
        )}`
      );
      return empty;
    }

    const servers: Record<string, McpAppServerConnection> = {};
    for (const server of result.data.mcpServers) {
      if (server.enabled) servers[server.name] = server.connection;
    }
    return { mtimeMs, agentId: result.data.id, servers };
  }
}

/** A fully-parsed manifest — the object form `readManifest` returns when present. */
type ManagedManifest = NonNullable<Awaited<ReturnType<typeof readManifest>>>;
