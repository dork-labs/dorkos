/**
 * OpenCode MCP concerns, owned off the runtime facade so `opencode-runtime.ts`
 * stays a thin adapter. Two responsibilities, both keyed by working directory
 * (OpenCode boots one sidecar instance per directory — NOTES.md §1):
 *
 * 1. **Read-only status** ({@link OpenCodeMcpManager.getStatus}, DOR-893) —
 *    surfaces the MCP servers OpenCode loaded for a directory from its own
 *    config, warmed out-of-band and peek-only (never boots the sidecar).
 * 2. **Managed injection** ({@link OpenCodeMcpManager.ensureManaged}, DOR-893) —
 *    registers an agent's ENABLED managed servers into the live sidecar per turn
 *    via `client.mcp.add`, reconciling against what was last injected.
 *
 * The sidecar's add/connect/disconnect mutate only its in-memory per-directory
 * registry (no `opencode.json` write, verified against the pin — NOTES.md §6),
 * so injection is ephemeral, exactly like claude's inline servers.
 *
 * @module services/runtimes/opencode/mcp-manager
 */
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { McpServerEntry } from '@dorkos/shared/transport';
import type { AgentRegistryPort, ManagedMcpServerResolver } from '@dorkos/shared/agent-runtime';
import { logger, logError } from '../../../lib/logger.js';
import { resolveDorkosMcpInjection } from '../shared/dorkos-mcp-injection.js';
import { DORKOS_MCP_SERVER_NAME } from '../shared/dorkos-tool-names.js';
import { enumerateOpenCodeMcpServers } from './mcp-status.js';
import { toOpenCodeMcpServers, type OpenCodeMcpServerConfig } from './mcp-server-config.js';
import type { OpenCodeClientProvider } from './session-mapper.js';

/**
 * How long a warmed per-directory MCP-status cache stays fresh before
 * {@link OpenCodeMcpManager.getStatus} kicks a background re-warm. OpenCode MCP
 * config changes out-of-band (the user's `opencode.json`, or `opencode mcp`
 * commands), so a lifetime cache would never reflect edits; a short TTL surfaces
 * them on the next poll while keeping the getter synchronous.
 */
const MCP_STATUS_TTL_MS = 60_000;

/**
 * What one reconcile settled, for a caller that has to describe the result to
 * the agent.
 *
 * Only `dorkosApplied` is reported, and only because the PROMPT depends on it:
 * a turn told it can post in rooms, whose `dorkos` server was never registered,
 * spends itself discovering that. Managed servers need no equivalent — nothing
 * writes prose about them.
 */
export interface EnsureManagedResult {
  /**
   * Whether the `dorkos` tool server is registered on this sidecar for this
   * directory right now. `false` covers every way it is absent: the experiment
   * is off, the directory hosts no agent, a user's own server owns the name, or
   * the add threw.
   */
  dorkosApplied: boolean;
}

/** What we last registered into a live sidecar instance for one directory. */
interface InjectedRecord {
  /** The client instance we injected into — a NEW one means the sidecar restarted. */
  client: OpencodeClient;
  /**
   * Managed server names WE actually registered (a successful `mcp.add`), for
   * targeted disconnect on removal. A name a user configured, a name we skipped
   * as a collision, and a name whose add failed are all absent — so the
   * disconnect loop can only ever touch servers we own, and a failed add is
   * retried next turn.
   */
  names: Set<string>;
  /** Signature of the desired set, so an unchanged turn is a cheap no-op. */
  signature: string;
  /**
   * Whether every desired (non-collision) server registered successfully. When
   * `false`, the early-return guard is skipped so a transient add failure is
   * retried on the next turn instead of being stranded for the session.
   */
  complete: boolean;
}

/**
 * Owns OpenCode's MCP status cache and managed-injection reconciliation. One
 * instance per runtime; the runtime delegates `getMcpStatus`,
 * `setManagedMcpServers`, and per-turn injection to it.
 */
export class OpenCodeMcpManager {
  /** Per-directory status cache (last enumerated servers + warm time). */
  private readonly statusCache = new Map<string, { servers: McpServerEntry[]; warmedAt: number }>();
  /** cwds with an in-flight status warm, so concurrent polls trigger at most one probe each. */
  private readonly warmInFlight = new Set<string>();
  /** Resolver for an agent's enabled managed servers; absent leaves sessions unmanaged. */
  private resolver: ManagedMcpServerResolver | undefined;
  /**
   * The agent registry, when the composition root injected it. Used only to
   * decide whether a directory hosts a registered agent worth minting an
   * identity for — the same guard the Claude and Codex adapters apply before
   * they mint. Absent leaves the `dorkos` tool server uninjected, which is the
   * safe default.
   */
  private meshCore: AgentRegistryPort | undefined;
  /** What managed servers we last injected, per directory. */
  private readonly injectedByCwd = new Map<string, InjectedRecord>();
  /**
   * Managed servers refused this run because their name is already owned by a
   * user-configured OpenCode server (a collision — never overwritten). Overlaid
   * by {@link getStatus} as `failed` entries so the roster shows the conflict.
   */
  private readonly conflictsByCwd = new Map<string, McpServerEntry[]>();

  /**
   * Construct the manager over a sidecar client source.
   *
   * @param provider - Sidecar client source. Status warming uses `peekClient()`
   *   only (never boots); injection receives a live client from the turn.
   */
  constructor(private readonly provider: OpenCodeClientProvider) {}

  /** Inject the managed-server resolver (the DOR-892 seam). */
  setResolver(resolver: ManagedMcpServerResolver): void {
    this.resolver = resolver;
  }

  /**
   * Accept the agent registry, so a reconcile can tell whether a directory hosts
   * a registered agent (the identity-mint guard for the `dorkos` tool server).
   *
   * @param meshCore - The agent registry port from the composition root.
   */
  setMeshCore(meshCore: AgentRegistryPort): void {
    this.meshCore = meshCore;
  }

  /**
   * The `dorkos` tool server for a directory, as a one-entry record to fold into
   * the desired set, or `{}` when it must not be injected.
   *
   * This is OpenCode's ONLY per-agent identity channel, and structurally so: its
   * sidecar is one shared process with a fixed environment, so there is no
   * `DORKOS_AGENT_TOKEN` env seam to use the way codex and claude-code do, and
   * there never will be. The token has to ride the server's own `headers`.
   *
   * @param cwd - The directory being reconciled.
   */
  private async resolveDorkosServer(cwd: string): Promise<Record<string, OpenCodeMcpServerConfig>> {
    const agent = this.meshCore?.getByPath(cwd);
    const injection = await resolveDorkosMcpInjection(
      agent ? cwd : undefined,
      agent?.displayName ?? agent?.name
    );
    if (!injection) return {};
    return {
      [DORKOS_MCP_SERVER_NAME]: {
        type: 'remote',
        url: injection.url,
        headers: injection.headers,
        enabled: true,
      },
    };
  }

  /**
   * Last-known MCP servers OpenCode loaded for a directory, or `null` until the
   * first successful warm. Kicks a background re-warm when the cache is missing
   * or stale, then returns the current value immediately (the getter is
   * synchronous by the {@link AgentRuntime} contract).
   *
   * Any managed server refused this session as a name collision with a
   * user-configured server is overlaid as a `failed` entry (replacing the
   * user's own live entry under the shared name), so the roster shows the
   * conflict rather than silently rendering the user's server as if it were the
   * managed one.
   *
   * @param cwd - Absolute project directory (the `directory` scope).
   */
  getStatus(cwd: string): McpServerEntry[] | null {
    this.maybeWarm(cwd);
    const base = this.statusCache.get(cwd)?.servers ?? null;
    const conflicts = this.conflictsByCwd.get(cwd);
    if (!conflicts || conflicts.length === 0) return base;
    const byName = new Map((base ?? []).map((entry) => [entry.name, entry]));
    for (const conflict of conflicts) byName.set(conflict.name, conflict);
    return [...byName.values()];
  }

  /**
   * Kick a background status warm for a cwd when warranted: none already in
   * flight for it, and either never warmed or last warmed longer than
   * {@link MCP_STATUS_TTL_MS} ago. Fire-and-forget.
   */
  private maybeWarm(cwd: string): void {
    if (this.warmInFlight.has(cwd)) return;
    const cached = this.statusCache.get(cwd);
    if (cached && Date.now() - cached.warmedAt < MCP_STATUS_TTL_MS) return;
    this.warmInFlight.add(cwd);
    void this.warm(cwd).finally(() => this.warmInFlight.delete(cwd));
  }

  /**
   * Warm the status cache for a cwd from the RUNNING sidecar. A cold sidecar
   * (`peekClient()` is null) is a no-op — never boot to serve a read-only
   * roster. A genuine probe failure ({@link enumerateOpenCodeMcpServers} returns
   * `null`) leaves the cache untouched so the next read retries; success
   * (including an empty list) caches the result and stamps the TTL.
   */
  private async warm(cwd: string): Promise<void> {
    const client = this.provider.peekClient();
    if (!client) return;
    const servers = await enumerateOpenCodeMcpServers(client, cwd);
    if (servers !== null) {
      this.statusCache.set(cwd, { servers, warmedAt: Date.now() });
    }
  }

  /**
   * Reconcile the sidecar's live managed MCP servers for a directory to match
   * the agent's ENABLED set (spec `mcp-server-management` §6). Registers each
   * enabled managed server via `client.mcp.add` (which connects it) and
   * disconnects any WE previously injected that is no longer enabled. `sse`
   * servers are dropped with a one-line debug log — OpenCode has no SSE
   * transport (mirrors codex's safe-withhold), never mismapped onto HTTP.
   *
   * ## Never clobbers a user's own server
   *
   * A managed server whose name is already owned by a user-configured OpenCode
   * server (present in the live `GET /mcp` set but never injected by us) is a
   * COLLISION: it is skipped, logged, and surfaced as a `failed` conflict via
   * {@link getStatus} — never `mcp.add`-ed over the user's server. And the
   * disconnect loop iterates only {@link InjectedRecord.names} (servers WE
   * registered), so a user's server can never be disconnected either.
   *
   * ## Cheap hot path, honest failure handling
   *
   * A repeat turn with the SAME live sidecar instance, an unchanged desired set,
   * AND a previous run that fully applied is a no-op (no round trip). A new
   * client instance means the sidecar restarted and dropped its in-memory
   * registry, so everything is re-added and nothing is removed. Adds are
   * best-effort and never fail the turn, but only names that ACTUALLY registered
   * are recorded — a transient add failure leaves `complete: false`, so the next
   * turn retries it instead of stranding it. A server whose add threw is absent
   * from `GET /mcp` and therefore renders as MISSING (not `failed`) in the
   * roster until it registers; only a name collision renders as `failed`.
   *
   * @param client - The live sidecar client for this turn.
   * @param cwd - The session/agent working directory (the `directory` scope).
   */
  async ensureManaged(client: OpencodeClient, cwd: string): Promise<EnsureManagedResult> {
    const managed = this.resolver
      ? toOpenCodeMcpServers(this.resolver.injectableServersForCwd(cwd))
      : { servers: {}, skipped: [] };
    if (managed.skipped.length > 0) {
      logger.debug(
        '[OpenCodeRuntime] skipped SSE managed MCP servers — OpenCode has no SSE transport',
        { cwd, skipped: managed.skipped }
      );
    }

    // The `dorkos` tool server is resolved on EVERY reconcile, and its identity
    // token is freshly minted each time (spec `tool-only-room-replies` §D4). It
    // is written LAST so a managed server can never shadow the name DorkOS owns.
    const servers: Record<string, OpenCodeMcpServerConfig> = {
      ...managed.servers,
      ...(await this.resolveDorkosServer(cwd)),
    };

    // A re-minted token changes `headers`, so it changes this signature, so the
    // no-op early return below does NOT fire and the server is re-added with the
    // fresh credential. That falls out of hashing the whole desired set rather
    // than its names — true by accident before DOR-1613, and pinned by a test
    // now, because the alternative is a session whose token quietly expires
    // mid-life and whose every room write then 401s.
    const signature = JSON.stringify(servers);
    const prev = this.injectedByCwd.get(cwd);
    // Nothing desired and nothing we ever injected here: no reconcile to do, and
    // — the reason this guard is worth its lines — no `GET /mcp` round trip on
    // every turn of an install that has neither managed servers nor the DorkOS
    // tools switched on. That is the common case, and it used to be served by an
    // early return on a missing resolver, which the `dorkos` entry made wrong.
    if (Object.keys(servers).length === 0 && prev === undefined) {
      return { dorkosApplied: false };
    }
    const sameInstance = prev !== undefined && prev.client === client;
    // Same live instance, identical desired set, AND everything applied last
    // run → nothing to do. A prior partial failure (`complete: false`) falls
    // through so the failed add is retried.
    if (sameInstance && prev.signature === signature && prev.complete) {
      return { dorkosApplied: prev.names.has(DORKOS_MCP_SERVER_NAME) };
    }

    // Names WE own on THIS live instance. On a new instance the sidecar's
    // in-memory registry was wiped, so we own nothing yet (and any name already
    // present is a user-configured server reloaded from its own config).
    const ownedNames = sameInstance ? prev.names : new Set<string>();
    // The live server set, to tell a user-configured collision from a name we
    // own. Best-effort: a failed read (usually an unreachable sidecar, where
    // `mcp.add` would fail too and record nothing) yields an empty set, so we
    // fall back to injecting rather than inventing a false conflict.
    const liveNames = await this.readLiveServerNames(client, cwd);

    const desiredNames = new Set(Object.keys(servers));
    // Disconnect only names WE injected that are no longer desired — never a
    // user's server, because `prev.names` holds only servers we registered.
    if (sameInstance) {
      for (const name of prev.names) {
        if (!desiredNames.has(name)) await this.disconnect(client, cwd, name);
      }
    }

    const appliedNames = new Set<string>();
    const conflicts: McpServerEntry[] = [];
    let complete = true;
    for (const [name, config] of Object.entries(servers)) {
      // A name already on the sidecar that we did NOT inject belongs to the
      // user — skip it rather than overwrite their server (and it stays out of
      // `appliedNames`, so we never disconnect it later).
      if (liveNames.has(name) && !ownedNames.has(name)) {
        conflicts.push({
          name,
          type: config.type === 'remote' ? 'http' : 'stdio',
          // Whose server the person can actually rename depends on which one is
          // DorkOS's. For a managed server the remedy is to rename it; for
          // `dorkos` that remedy is impossible — DorkOS owns that name and
          // cannot move off it — so the honest instruction is to rename THEIR
          // server instead.
          status: 'failed',
          error:
            name === DORKOS_MCP_SERVER_NAME
              ? `a server named "${name}" is already configured in OpenCode — rename yours so DorkOS can inject its tools`
              : `"${name}" is already configured in OpenCode — rename the managed server to inject it`,
        });
        logger.warn(
          `[OpenCodeRuntime] managed MCP server "${name}" collides with a user-configured OpenCode server — not injected`,
          { cwd }
        );
        continue;
      }
      try {
        const result = await client.mcp.add({ query: { directory: cwd }, body: { name, config } });
        if (result.error !== undefined) {
          throw new Error(JSON.stringify(result.error));
        }
        appliedNames.add(name);
      } catch (err) {
        complete = false;
        logger.warn(
          `[OpenCodeRuntime] failed to inject managed MCP server "${name}"`,
          logError(err)
        );
      }
    }
    this.injectedByCwd.set(cwd, { client, names: appliedNames, signature, complete });
    if (conflicts.length > 0) this.conflictsByCwd.set(cwd, conflicts);
    else this.conflictsByCwd.delete(cwd);
    // Only a name that ACTUALLY registered is in `appliedNames`, so a collision
    // and a thrown add both report `false` here — which is the point: the caller
    // uses this to decide whether to tell the agent it has room tools.
    return { dorkosApplied: appliedNames.has(DORKOS_MCP_SERVER_NAME) };
  }

  /**
   * The names of every MCP server currently loaded on the sidecar for a
   * directory (`GET /mcp`). Used to distinguish a user-configured server from
   * one we injected. Best-effort — a failed read returns an empty set (see
   * {@link ensureManaged}).
   */
  private async readLiveServerNames(client: OpencodeClient, cwd: string): Promise<Set<string>> {
    try {
      const result = await client.mcp.status({ query: { directory: cwd } });
      return result.data === undefined ? new Set() : new Set(Object.keys(result.data));
    } catch (err) {
      logger.debug(
        '[OpenCodeRuntime] MCP live-set read failed — assuming no collisions',
        logError(err)
      );
      return new Set();
    }
  }

  /** Disconnect one previously-injected managed server from the live sidecar (best-effort). */
  private async disconnect(client: OpencodeClient, cwd: string, name: string): Promise<void> {
    try {
      await client.mcp.disconnect({ path: { name }, query: { directory: cwd } });
    } catch (err) {
      logger.warn(
        `[OpenCodeRuntime] failed to disconnect managed MCP server "${name}"`,
        logError(err)
      );
    }
  }
}
