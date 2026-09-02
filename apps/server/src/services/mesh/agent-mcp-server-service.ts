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
import { readManifest, writeManifest, MANIFEST_DIR, MANIFEST_FILE } from '@dorkos/shared/manifest';
import { AgentManifestSchema, McpServerTransportSchema } from '@dorkos/shared/mesh-schemas';
import type {
  ManagedMcpServer,
  ManagedMcpServerView,
  McpClientOrigin,
  McpServerAuthStatus,
  McpServerTransport,
} from '@dorkos/shared/mesh-schemas';
import type { McpAppServerConnection } from '@dorkos/shared/agent-runtime';
import type { Logger } from '@dorkos/shared/logger';

import { readMcpJsonServers, resolveMcpJsonConnection } from './mcp-json.js';
import { runProbe, settledWithin, ADD_PROBE_BUDGET_MS } from './agent-mcp-probe.js';

/** The DorkOS tool server's own name — reserved so a managed server can never shadow it. */
export const RESERVED_MCP_SERVER_NAME = 'dorkos';

/** The HTTP header a managed-MCP OAuth access token is injected under. */
const AUTHORIZATION_HEADER = 'Authorization';

/**
 * The managed-MCP OAuth port this service talks to (DOR-942): the synchronous
 * access-token lookup the injection path consults, plus the credential cleanup a
 * removed or re-pointed server triggers. Satisfied structurally by
 * `AgentMcpOAuthService`; kept as a narrow port so this runtime-neutral service
 * never imports the OAuth engine (or, through it, the MCP SDK auth module) as a
 * value.
 */
export interface McpOAuthTokenProvider {
  /**
   * The live bearer access token for `(agentId, serverName)` at `serverUrl`, or
   * `undefined` when none is cached — in which case injection withholds the header
   * (needs-auth). The URL is part of the question, not decoration: a token minted
   * for one server must never be sent to whatever later takes that server's name.
   *
   * @param agentId - The owning agent's id.
   * @param serverName - The managed server's name.
   * @param serverUrl - The URL the token is about to be sent to.
   */
  getAccessToken(agentId: string, serverName: string, serverUrl: string): string | undefined;

  /**
   * Forget every stored credential for one managed server. Removing a server, or
   * pointing it at a different URL, has to take the credential with it — otherwise
   * "you can remove the server anytime" is true of the row and false of the token.
   *
   * @param agentId - The owning agent's id.
   * @param serverName - The managed server's name.
   */
  forgetServer(agentId: string, serverName: string): Promise<void>;

  /**
   * Where the OAuth client identity DorkOS would sign in with came from — the
   * provider registering DorkOS automatically, or app credentials the operator
   * supplied for a provider that will not (DOR-982). `undefined` when DorkOS
   * holds no client identity for the server.
   *
   * Optional so a port satisfied for injection alone still type-checks; the
   * listing simply reports no origin when it is absent. It names the identity —
   * it never exposes it.
   *
   * @param agentId - The owning agent's id.
   * @param serverName - The managed server's name.
   */
  clientOrigin?(agentId: string, serverName: string): Promise<McpClientOrigin | undefined>;
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
   * List every managed server declared on an agent's manifest, each decorated
   * with its derived {@link ManagedMcpServerView.authStatus}.
   *
   * The decoration is what lets a freshly-started server answer "does this need
   * signing in?" at all: the runtimes' own MCP status caches are written during
   * turns, so before the agent's first message of the process there is no live
   * status to read and every row would otherwise read "Unknown" (DOR-985). It is
   * computed per call and never persisted — see {@link deriveAuthStatus}.
   *
   * @param agentId - The agent's id.
   * @returns The manifest's `mcpServers`, decorated (empty when none).
   */
  async list(agentId: string): Promise<ManagedMcpServerView[]> {
    const { manifest } = await this.load(agentId);
    return Promise.all(
      manifest.mcpServers.map(async (server) => {
        const authStatus = this.deriveAuthStatus(agentId, server);
        const authClientOrigin = await this.readClientOrigin(agentId, server);
        return {
          ...server,
          ...(authStatus ? { authStatus } : {}),
          ...(authClientOrigin ? { authClientOrigin } : {}),
        };
      })
    );
  }

  /**
   * Which OAuth client identity DorkOS holds for a server, when it holds one
   * (DOR-982) — the fact behind the Details row's "using your own app
   * credentials".
   *
   * Skipped outright for a stdio server, which has no OAuth at all, so the
   * common case costs nothing. Failure is swallowed to `undefined`: a listing
   * must not break because one encrypted record could not be read, and a missing
   * origin only costs the row a qualifier.
   */
  private async readClientOrigin(
    agentId: string,
    server: ManagedMcpServer
  ): Promise<McpClientOrigin | undefined> {
    if (server.connection.transport === 'stdio') return undefined;
    if (!this.tokenProvider?.clientOrigin) return undefined;
    try {
      return await this.tokenProvider.clientOrigin(agentId, server.name);
    } catch (err) {
      this.logger.warn(
        `[mcp] could not read the sign-in client for "${server.name}": ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return undefined;
    }
  }

  /**
   * Whether a managed server has a usable DorkOS-held sign-in right now.
   *
   * A live cached token wins outright — it is the same lookup injection makes,
   * the entry's CURRENT url included (DOR-986), so "connected" here means the
   * next turn really does carry a bearer to this endpoint. A token left over
   * from before the server was re-pointed reads as absent, exactly as it does at
   * injection. Failing that, an `authKind: 'oauth2'` entry is one DorkOS knows
   * wants a sign-in it does not hold, which is `needs-auth`. Anything else
   * (stdio, or a remote server that has never demanded auth) gets no opinion
   * rather than a guess.
   *
   * One exception sits between those: an entry that carries its OWN
   * `Authorization` header. The operator pasted a token in at `add`, so the
   * server is authenticated without DorkOS holding anything, and calling it
   * needs-auth would put a Sign in button on a server that does not need one.
   * DorkOS has no opinion about a credential it does not manage.
   *
   * @param agentId - The owning agent's id.
   * @param server - The stored managed entry.
   */
  private deriveAuthStatus(
    agentId: string,
    server: ManagedMcpServer
  ): McpServerAuthStatus | undefined {
    const { connection } = server;
    if (connection.transport === 'stdio') return undefined;
    if (this.tokenProvider?.getAccessToken(agentId, server.name, connection.url))
      return 'connected';
    if (connection.authKind !== 'oauth2') return undefined;
    return hasOwnAuthorizationHeader(connection.headers) ? undefined : 'needs-auth';
  }

  /**
   * Record that a remote managed server authenticates with OAuth, when evidence
   * says so and the entry does not already say it.
   *
   * Evidence beats declaration here: a server added before DorkOS knew to ask
   * (or added by hand) carries no `authKind`, so it reads as "no opinion"
   * forever and never offers a sign-in. A 401 from the reachability probe, or a
   * sign-in that the provider actually accepted, both prove the server is
   * OAuth-protected — so the entry is healed on the spot and every later listing
   * says `needs-auth` without re-probing (DOR-985).
   *
   * A no-op for a stdio server, an entry already marked, or an unknown name.
   *
   * @param agentId - The agent's id.
   * @param name - The managed server the evidence is about.
   * @returns Whether the manifest was written.
   */
  async learnOAuthAuthKind(agentId: string, name: string): Promise<boolean> {
    const { projectPath, manifest } = await this.load(agentId);
    const existing = manifest.mcpServers.find((s) => s.name === name);
    if (!existing || existing.connection.transport === 'stdio') return false;
    if (existing.connection.authKind === 'oauth2') return false;

    const updated: ManagedMcpServer = {
      ...existing,
      connection: { ...existing.connection, authKind: 'oauth2' },
    };
    await this.persist(
      projectPath,
      manifest,
      manifest.mcpServers.map((s) => (s.name === name ? updated : s))
    );
    return true;
  }

  /**
   * Add a managed server to an agent and persist the manifest.
   *
   * Rejects the reserved name `dorkos` (which the injection order reserves for
   * the DorkOS tool server) and any name already present on the agent. Enables
   * the server by default — an add is an explicit, gated action (spec §4).
   *
   * ## The advisory sign-in probe (DOR-1003)
   *
   * A remote server is dialled once on the way in, purely to answer "does this
   * need a sign-in?". A clean 401 stamps `authKind: 'oauth2'` on the entry
   * BEFORE it is persisted, so the very first listing says needs-auth and the
   * agent can offer the sign-in in the same breath as the add — instead of the
   * operator adding a server, seeing nothing, and finding out only when a turn
   * fails.
   *
   * It is ADVISORY in both directions. Any other outcome — a 200, a timeout, DNS
   * that does not resolve — persists exactly what the caller asked for; the probe
   * can add a fact, never withhold or change the add. And it is bounded by
   * {@link ADD_PROBE_BUDGET_MS} rather than the full probe timeout, because a
   * person is waiting on this call: a server that has not answered inside the
   * budget is persisted unstamped, while the probe keeps running in the
   * background and heals the entry through {@link learnOAuthAuthKind} if it turns
   * out to be a 401 after all.
   *
   * @param opts - The agent id, server name, connection, approver, and optional enabled flag.
   * @returns The updated `mcpServers` list.
   * @throws {AgentMcpServerError} `RESERVED_NAME` or `DUPLICATE_NAME`.
   */
  async add(opts: AddManagedServerOptions): Promise<ManagedMcpServer[]> {
    const { projectPath, manifest } = await this.load(opts.agentId);
    this.assertNameAvailable(manifest.mcpServers, opts.name);

    const probe = this.probeForOAuth(opts.connection);
    const learnedInTime = probe ? await settledWithin(probe, ADD_PROBE_BUDGET_MS, false) : false;

    const entry: ManagedMcpServer = {
      name: opts.name,
      enabled: opts.enabled ?? true,
      connection: learnedInTime ? withOAuthAuthKind(opts.connection) : opts.connection,
      addedAt: new Date().toISOString(),
      addedBy: opts.addedBy,
    };
    const next = [...manifest.mcpServers, entry];
    await this.persist(projectPath, manifest, next);
    if (probe && !learnedInTime) this.learnFromLateProbe(opts.agentId, opts.name, probe);
    return next;
  }

  /**
   * Start the advisory "does this want a sign-in?" probe for a connection being
   * added, or `undefined` when there is nothing to learn.
   *
   * Three connections are left alone. A stdio server has no OAuth endpoint. An
   * entry that already declares `authKind: 'oauth2'` is already saying what the
   * probe would tell us. And an entry carrying its OWN `Authorization` header is
   * a credential the operator pasted in, which DorkOS neither holds nor refreshes
   * — the same carve-out {@link deriveAuthStatus} makes, and it has to be made
   * here too or the two surfaces disagree about one row: a stale static token
   * 401s, the probe stamps `oauth2`, `mcp.add` then tells the agent to launch an
   * OAuth sign-in the operator never asked for, while `list()` still reports no
   * opinion for that very entry.
   *
   * Resolves `true` only on a clean 401. A brand-new entry holds no DorkOS token
   * yet, so the bare stored connection is exactly what a turn would dial.
   *
   * @param connection - The connection the caller asked to add.
   */
  private probeForOAuth(connection: McpServerTransport): Promise<boolean> | undefined {
    if (connection.transport === 'stdio') return undefined;
    if (connection.authKind === 'oauth2') return undefined;
    if (hasOwnAuthorizationHeader(connection.headers)) return undefined;
    return runProbe(connection, this.probeFetch).then((outcome) => outcome.kind === 'unauthorized');
  }

  /**
   * Adopt a probe that came back after {@link add} stopped waiting for it: a late
   * 401 still heals the entry, one write later than the fast path. Fire-and-forget
   * by design — the add has already returned, so there is nobody left to report a
   * failure to, and it is logged instead.
   */
  private learnFromLateProbe(agentId: string, name: string, probe: Promise<boolean>): void {
    void probe
      .then(async (needsAuth) => {
        if (needsAuth) await this.learnOAuthAuthKind(agentId, name);
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `[agent-mcp] could not record authKind for "${name}": ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      });
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
   * Re-pointing the server at a different endpoint drops its OAuth credentials:
   * the token was issued by the old server, for the old server, and the operator
   * has to sign in to the new one (DOR-986).
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
    if (endpointOf(existing.connection) !== endpointOf(updated.connection)) {
      await this.forgetOAuthCredentials(opts.agentId, opts.name);
    }
    return next;
  }

  /**
   * Remove a managed server from an agent, taking any OAuth credentials it holds
   * with it — the stored token, the dynamic client registration, and the cached
   * bearer plus its background refresh. Removing the row while the credential
   * lived on is what made "you can remove the server anytime" a half-truth
   * (DOR-986). Reversible by re-adding, which needs a fresh sign-in.
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
    await this.forgetOAuthCredentials(agentId, name);
    return next;
  }

  /**
   * Drop a server's OAuth credentials, if an OAuth engine is wired at all. Never
   * fails the caller: the manifest write already succeeded, so a store hiccup
   * must not report the removal as failed — it is logged instead.
   */
  private async forgetOAuthCredentials(agentId: string, name: string): Promise<void> {
    if (!this.tokenProvider) return;
    await this.tokenProvider.forgetServer(agentId, name).catch((err: unknown) => {
      this.logger.warn(
        `[agent-mcp] could not clear stored sign-in for "${name}": ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    });
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
    const entry = this.injectionEntryFor(cwd);
    if (!entry) return {};
    return this.mergeOAuthHeaders(entry.agentId, entry.servers);
  }

  /**
   * Resolve one server NAME, seen at a session's working directory, back to the
   * OAuth target it belongs to — or `undefined` when DorkOS manages no sign-in
   * for it (DOR-981).
   *
   * The runtimes report MCP trouble by name and cwd, which is all a subprocess
   * knows; every credential decision needs `(agentId, serverName, serverUrl)`.
   * This is the one translation between them, and it also enforces which servers
   * a sign-in may ever be offered for:
   *
   * - **stdio** has no remote endpoint and takes no bearer.
   * - **An entry carrying its OWN `Authorization` header** is a credential the
   *   operator pasted in. Its 401 is their token to fix, not a DorkOS OAuth
   *   sign-in to launch — the same carve-out {@link deriveAuthStatus} and
   *   {@link probeForOAuth} make, made a third time because this is a third
   *   surface that could otherwise put a Sign in button on a row that needs none.
   *
   * Synchronous and mtime-memoized, sharing {@link injectableServersForCwd}'s
   * cache: it answers the same question off the same parse.
   *
   * @param cwd - The session's working directory (the agent's workspace path).
   * @param serverName - The managed server's name as the runtime reported it.
   */
  oauthTargetForCwd(
    cwd: string,
    serverName: string
  ): { agentId: string; serverName: string; serverUrl: string } | undefined {
    const entry = this.injectionEntryFor(cwd);
    if (!entry?.agentId) return undefined;
    const connection = entry.servers[serverName];
    if (!connection || connection.transport === 'stdio') return undefined;
    if (hasOwnAuthorizationHeader(connection.headers)) return undefined;
    return { agentId: entry.agentId, serverName, serverUrl: connection.url };
  }

  /**
   * The mtime-memoized parse of the manifest at `cwd`, or `undefined` when there
   * is no readable one. Shared by every cwd-keyed reader so they cannot disagree
   * about which enabled servers a directory has.
   */
  private injectionEntryFor(cwd: string): InjectionCacheEntry | undefined {
    const manifestPath = path.join(cwd, MANIFEST_DIR, MANIFEST_FILE);

    let mtimeMs: number;
    try {
      mtimeMs = statSync(manifestPath).mtimeMs;
    } catch {
      this.injectionCache.delete(cwd);
      return undefined;
    }

    const cached = this.injectionCache.get(cwd);
    const entry =
      cached && cached.mtimeMs === mtimeMs
        ? cached
        : this.readEnabledServersSync(manifestPath, cwd, mtimeMs);
    if (entry !== cached) this.injectionCache.set(cwd, entry);
    return entry;
  }

  /**
   * Return a per-read copy of the enabled servers with an `Authorization: Bearer`
   * header merged into each http/sse entry that has a live cached OAuth token, and
   * left untouched otherwise. The safe default is withholding: no token → no
   * header → the server reports needs-auth rather than connecting unauthenticated
   * (`.claude/rules/safe-defaults.md`). Never mutates the cached base map.
   *
   * The entry's CURRENT url is part of the lookup, so a token minted for the
   * server this name used to point at is never sent to the one it points at now
   * (DOR-986).
   *
   * WHERE THE HEADER TRAVELS, per runtime (DOR-993, closing the DOR-986
   * exposure): claude-code and opencode hand it over out of band. Codex used to
   * be the exception — the header left this process as a `codex exec` config
   * override, which `@openai/codex-sdk` serializes into the subprocess's argv,
   * so the bearer was readable by anything on this machine that could list
   * processes. It no longer is: the codex adapter names each header by
   * environment variable (`env_http_headers`) and puts the VALUE in the
   * subprocess environment, so no header value reaches a command line
   * (`runtimes/codex/mcp-server-config.ts`). The one credential still written
   * into codex config is a STDIO server's own `env` block, which the operator
   * typed into the server's definition — Codex offers no redirection there that
   * lets DorkOS choose the variable name the child sees, and that path never
   * carries an OAuth token this service minted.
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
      const headers = this.oauthHeadersFor(agentId, name, connection.url, connection.headers);
      out[name] = headers ? { ...connection, headers } : connection;
    }
    return out;
  }

  /**
   * The headers to send a remote managed server when DorkOS holds a live OAuth
   * token for it, or `undefined` when it holds none (leave the entry alone).
   *
   * **The single place the bearer rule lives**, and it carries two invariants at
   * once. Every path that talks to a remote managed server goes through it —
   * session injection ({@link mergeOAuthHeaders}) and the reachability probe
   * ({@link test}) — so they cannot drift into disagreeing about whether a server
   * is authenticated. They did once: the probe read the STORED connection and
   * sent no bearer, so a server the operator had just signed into still answered
   * 401 and the row co-rendered "Connected" with "Needs sign-in — click Sign in"
   * (DOR-985).
   *
   * 1. **URL binding (DOR-986).** `serverUrl` is part of the lookup, not
   *    decoration: a token minted for the server this name used to point at is
   *    never sent to the one it points at now. The probe is subject to this too —
   *    it dials a real endpoint, so it must not be the hole the binding leaks
   *    through.
   * 2. **One authorization header.** Any declared `Authorization` is dropped
   *    before the bearer is added, whatever its casing, so the two never ride
   *    together and leave the server to pick.
   *
   * `undefined` is the safe default: no token → no header → the server reports
   * needs-auth rather than being contacted unauthenticated
   * (`.claude/rules/safe-defaults.md`).
   *
   * @param agentId - The owning agent's id.
   * @param serverName - The managed server's name.
   * @param serverUrl - The URL the headers are about to be sent to.
   * @param headers - The entry's declared headers, if any.
   */
  private oauthHeadersFor(
    agentId: string,
    serverName: string,
    serverUrl: string,
    headers: Record<string, string> | undefined
  ): Record<string, string> | undefined {
    const token = this.tokenProvider?.getAccessToken(agentId, serverName, serverUrl);
    if (!token) return undefined;
    return { ...withoutAuthorizationHeader(headers), [AUTHORIZATION_HEADER]: `Bearer ${token}` };
  }

  /**
   * The connection the reachability probe should dial: the stored one, plus the
   * OAuth bearer when DorkOS holds a live token for THAT url — exactly what a
   * turn would inject, so Test reports what the agent would actually experience.
   *
   * @param agentId - The owning agent's id.
   * @param server - The stored managed entry.
   */
  private probeConnection(agentId: string, server: ManagedMcpServer): McpServerTransport {
    const { connection } = server;
    if (connection.transport === 'stdio') return connection;
    const headers = this.oauthHeadersFor(agentId, server.name, connection.url, connection.headers);
    return headers ? { ...connection, headers } : connection;
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
   * It dials the connection a TURN would dial, bearer included
   * ({@link probeConnection}) — probing the bare stored connection made a
   * signed-in server report needs-auth forever (DOR-985).
   *
   * A 401 / unauthorized probe is classified as `needsAuth: true` (DOR-942) so the
   * client can render "Needs sign-in" instead of the raw SDK error; every other
   * failure keeps its raw message with `needsAuth` absent. That same 401 is also
   * evidence the server is OAuth-protected, so it is written back through
   * {@link learnOAuthAuthKind} — one Test heals an entry that never carried the
   * hint, and it reports needs-auth from then on (DOR-985).
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

    const outcome = await runProbe(this.probeConnection(agentId, server), this.probeFetch);
    if (outcome.kind === 'ok') return { ok: true, toolCount: outcome.toolCount };
    if (outcome.kind === 'failed') return { ok: false, error: outcome.error };
    // Best-effort: the probe's answer is what the caller asked for, so a failed
    // manifest write must not turn a useful result into an error.
    await this.learnOAuthAuthKind(agentId, name).catch((writeErr: unknown) => {
      this.logger.warn(
        `[agent-mcp] could not record authKind for "${name}": ${
          writeErr instanceof Error ? writeErr.message : String(writeErr)
        }`
      );
      return false;
    });
    return { ok: false, needsAuth: true, error: outcome.error };
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

/**
 * The remote endpoint a connection authorizes against, or `null` for stdio (which
 * has none). Used to decide whether an update re-pointed the server, and so
 * whether its OAuth credentials still belong to it.
 *
 * @param connection - The stored transport.
 */
function endpointOf(connection: McpServerTransport): string | null {
  return connection.transport === 'stdio' ? null : connection.url;
}

/**
 * The same connection, declaring that it authenticates with OAuth. A stdio
 * connection is returned untouched — it has no remote endpoint to authorize
 * against, so the hint would be meaningless there.
 *
 * @param connection - The connection to stamp.
 */
function withOAuthAuthKind(connection: McpServerTransport): McpServerTransport {
  if (connection.transport === 'stdio') return connection;
  return { ...connection, authKind: 'oauth2' };
}

/**
 * Whether a header name is the authorization header under any casing. HTTP header
 * names are case-insensitive but a plain object's keys are not, so both readers
 * below share this one comparison rather than each spelling it out.
 *
 * @param name - A header name from a stored entry.
 */
function isAuthorizationHeaderName(name: string): boolean {
  return name.toLowerCase() === AUTHORIZATION_HEADER.toLowerCase();
}

/**
 * Drop any existing authorization header, whatever its casing, so merging the
 * OAuth bearer replaces it instead of sitting beside it: leaving an
 * `authorization` next to our `Authorization` sends both, and the server picks
 * one.
 *
 * @param headers - The entry's declared headers, if any.
 */
function withoutAuthorizationHeader(
  headers: Record<string, string> | undefined
): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !isAuthorizationHeaderName(name))
  );
}

/**
 * Whether a stored connection already carries its own `Authorization` header — a
 * credential the operator supplied, which DorkOS neither holds nor refreshes.
 *
 * @param headers - The entry's stored headers.
 */
function hasOwnAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  return Object.keys(headers ?? {}).some(isAuthorizationHeaderName);
}

/** A fully-parsed manifest — the object form `readManifest` returns when present. */
type ManagedManifest = NonNullable<Awaited<ReturnType<typeof readManifest>>>;
