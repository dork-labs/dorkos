/**
 * Session tool exposure — the seam that turns connected accounts into MCP tool
 * servers inside a session (connector-gateway spec §Detailed Design 3).
 *
 * It adds NO new session-side injection mechanism: it reuses the existing
 * `AgentRuntime.setMcpServerFactory` seam. Per session, it holds the set of
 * accounts a user has explicitly attached (the consent binding — the same
 * "this account is exposed to this session" shape as relay's `BindingSubsystem`,
 * but IN MEMORY, not persisted; see Durability below), resolves each attached
 * account's {@link ConnectorProvider.toolServerForAccount} once and caches the neutral
 * connection for the session lifetime, and folds those connections into a
 * `Record<string, McpAppServerConnection>` keyed by a provider-neutral server
 * name (`gmail-personal`, `gmail-work`). The claude-code factory converts that
 * record to the SDK config shape (`toSdkMcpServers`) and merges it alongside the
 * built-in `dorkos` server.
 *
 * Three invariants from the spec, enforced here:
 *
 * - **No provider leakage (G2).** A server name is built only from toolkit +
 *   label (never the owning provider), and the connector metadata this service
 *   reads comes from the registry's provider-neutral binding row — the vendor
 *   type is used solely to route `toolServerForAccount`, never surfaced.
 * - **The null branch (LOCKED).** When `toolServerForAccount` resolves `null`
 *   (expired / revoked / unavailable), the account is skipped and surfaced as a
 *   per-account warning in the session's connector status — never a throw and
 *   never a silent drop.
 * - **Consent per-account → session.** A session receives a tool server ONLY for
 *   accounts explicitly {@link SessionConnectorService.attach | attached} to it;
 *   attaching re-shows the custody disclosure.
 *
 * A runtime without the MCP seam (`supportsMcp: false`, or no
 * `setMcpServerFactory`) simply never calls the factory, so it receives no
 * connector tool servers — the session status still lists what is attached, so
 * the absence is honest, not an error.
 *
 * **Durability (connection-scoping spec, `specs/connection-scoping/`).** The
 * RESOLVED connection (`McpAppServerConnection`) is still held IN MEMORY,
 * process-scoped — it is a live provider handle, not serializable data. What
 * IS now durable is the INTENT: a session-level attach/detach persists an
 * override row via {@link SessionConnectorAttachmentStore}, and an
 * agent-level attach persists standing consent via
 * {@link AgentConnectorAttachmentStore}. After a restart, a session's first
 * turn calls {@link SessionConnectorService.hydrateSession}, which reads both
 * tables, re-resolves each effective account's connection through its
 * provider, and populates the in-memory cache exactly as a live `attach`
 * would — so the person never re-attaches by hand. See
 * `specs/connection-scoping/design-decisions.md` D1/D2 for why this is two
 * SQLite tables rather than a JSON file or a `config.json` field.
 *
 * @module services/connectors/session-exposure
 */
import type { ConnectedAccountId } from '@dorkos/shared/connector-provider';
import type { McpAppServerConnection } from '@dorkos/shared/agent-runtime';
import { logger } from '../../lib/logger.js';
import { disclosureForAccount } from './custody-disclosure.js';
import type { ConnectedAccountBinding, ConnectorRegistry } from './registry.js';
import type {
  AgentConnectorAttachmentStore,
  SessionConnectorAttachmentStore,
} from './attachment-store.js';

/**
 * Server names DorkOS reserves for its own built-in MCP servers. A connector
 * tool server may never take one of these, because the MCP factory spreads
 * connector servers AFTER the built-ins (`{ dorkos, ...connectorServers }`) — a
 * collision would silently shadow the built-in. A connector whose natural name
 * would collide is minted a suffixed name instead (and the shadow attempt is
 * logged), so the account stays usable and the built-in is never overwritten.
 */
const RESERVED_SERVER_NAMES = new Set<string>(['dorkos']);

/**
 * Why an attached account is not currently exposed as a tool server — the
 * surfaced form of the `toolServerForAccount` null branch.
 */
export type SessionConnectorUnavailableReason = 'expired' | 'revoked' | 'unavailable';

/** A per-account notice that an attached account could not be exposed right now. */
export interface SessionConnectorWarning {
  /** The attached account this warning is about. */
  accountId: ConnectedAccountId;
  /** The account's user-facing label, for a "reconnect {label}" affordance. */
  label: string;
  /**
   * Why it is not exposed (drives the reconnect prompt copy). Derived from the
   * reconciled `connected_accounts` binding cache — best-effort, not
   * authoritative; a live provider check may disagree until the cache reconciles.
   */
  reason: SessionConnectorUnavailableReason;
}

/** One attached account's status in a session's connector surface. */
export interface SessionConnectorAccountStatus {
  /** The attached account id. */
  accountId: ConnectedAccountId;
  /** Service slug, e.g. `'gmail'`. */
  toolkit: string;
  /** User-facing label, e.g. `'work'`. */
  label: string;
  /** Lifecycle status echoed from the routing binding. */
  status: ConnectedAccountBinding['status'];
  /** The provider-neutral MCP server name this account is exposed under, when exposed. */
  serverName?: string;
  /** Whether the account is currently exposed as a tool server (non-null connection). */
  exposed: boolean;
}

/** The connector surface for one session: what is attached, and what degraded. */
export interface SessionConnectorStatus {
  /** Every account attached to this session, each with its exposure state. */
  accounts: SessionConnectorAccountStatus[];
  /** Per-account warnings for attached accounts that could not be exposed. */
  warnings: SessionConnectorWarning[];
}

/** The result of attaching one account to a session. */
export interface AttachResult {
  /** The attached account's session-facing status row. */
  account: SessionConnectorAccountStatus;
  /** The custody disclosure to re-show at the consent point (spec §4). */
  disclosure: string;
  /** Present when the account attached but is not exposable right now (null branch). */
  warning?: SessionConnectorWarning;
}

/** The neutral tool servers for a session, plus any null-branch warnings. */
export interface SessionMcpServers {
  /** Provider-neutral connections keyed by server name, ready for the MCP factory. */
  servers: Record<string, McpAppServerConnection>;
  /** Per-account warnings for attached accounts whose connection resolved null. */
  warnings: SessionConnectorWarning[];
}

/** Construction options for {@link SessionConnectorService}. */
export interface SessionConnectorServiceOpts {
  /** The registry that routes an account id to its provider and its binding row. */
  registry: ConnectorRegistry;
  /** Standing, agent-level attachment store (connection-scoping spec §Part 1). */
  agentAttachments: AgentConnectorAttachmentStore;
  /** Persisted per-session attach/detach override store. */
  sessionAttachments: SessionConnectorAttachmentStore;
}

/** The cached resolution of one attached account. */
interface AttachedAccount {
  /** The provider-neutral routing/naming metadata for this account. */
  binding: ConnectedAccountBinding;
  /**
   * The resolved tool-server connection, or `null` when the account cannot be
   * exposed right now (the surfaced null branch). Cached for the session
   * lifetime; a re-`attach` re-resolves it (invalidate-on-status-change).
   */
  connection: McpAppServerConnection | null;
  /**
   * The MCP server name PINNED to this account at attach time for the session
   * lifetime. Stored (not recomputed positionally) so detaching one account can
   * never rename a sibling — e.g. detaching `gmail-shared` leaves
   * `gmail-shared-2` exactly as it was.
   */
  serverName: string;
}

/**
 * Turn an attached account's toolkit + label into a stable, provider-neutral
 * MCP server name: lowercase, non-alphanumerics collapsed to single dashes.
 * The provider type is deliberately never an input.
 *
 * @param toolkit - The service slug, e.g. `'gmail'`.
 * @param label - The user-facing label, e.g. `'Work Account'`.
 */
function baseServerName(toolkit: string, label: string): string {
  const slug = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  const toolkitSlug = slug(toolkit) || 'connector';
  const labelSlug = slug(label);
  return labelSlug ? `${toolkitSlug}-${labelSlug}` : toolkitSlug;
}

/**
 * Per-account → session tool-server binder over the existing MCP factory seam.
 */
export class SessionConnectorService {
  private readonly _registry: ConnectorRegistry;
  private readonly _agentAttachments: AgentConnectorAttachmentStore;
  private readonly _sessionAttachments: SessionConnectorAttachmentStore;
  /** sessionId → (accountId → cached resolution). */
  private readonly _sessions = new Map<string, Map<string, AttachedAccount>>();
  /**
   * Sessions that have already run {@link hydrateSession} in this process.
   * Hydration is idempotent by construction (re-deriving the same effective
   * set is harmless), but skipping the repeat work — and the repeat provider
   * calls — is why every turn can call it unconditionally.
   */
  private readonly _hydrated = new Set<string>();

  /**
   * Construct the binder over the connector registry and the two persisted
   * attachment stores.
   *
   * @param opts - See {@link SessionConnectorServiceOpts}.
   */
  constructor(opts: SessionConnectorServiceOpts) {
    this._registry = opts.registry;
    this._agentAttachments = opts.agentAttachments;
    this._sessionAttachments = opts.sessionAttachments;
  }

  /**
   * Attach a connected account to a session (the consent point). Resolves and
   * caches the account's tool-server connection, persists a `'attached'`
   * session-level override (connection-scoping spec §Part 1 — this is what
   * lets the attachment survive a restart and what lets it suppress an
   * agent-level detach later), and returns the custody disclosure to re-show
   * plus the account's exposure state.
   *
   * Returns `undefined` when the account id is unknown — the caller maps that to
   * a 404. A known account whose `toolServerForAccount` resolves `null` still
   * attaches (consent is recorded), but is reported unexposed via a warning.
   *
   * @param sessionId - The session the account is being attached to.
   * @param accountId - The opaque account handle to attach.
   */
  async attach(
    sessionId: string,
    accountId: ConnectedAccountId
  ): Promise<AttachResult | undefined> {
    const result = await this._resolveAndCache(sessionId, accountId);
    if (!result) return undefined;
    this._sessionAttachments.setState(sessionId, accountId, 'attached');
    return result;
  }

  /**
   * Detach an account from a session. Idempotent — detaching an unattached
   * account (or a session with nothing attached) is a no-op in memory, but
   * ALWAYS persists a `'detached'` override (connection-scoping spec §Part
   * 1): the override is a tombstone, not a delete, because "no record" and
   * "explicitly turned off" are different states in the ladder — the former
   * inherits the agent's standing attachment on the next hydration, the
   * latter suppresses it. See `specs/connection-scoping/design-decisions.md`
   * D2.
   *
   * @param sessionId - The session to detach from.
   * @param accountId - The opaque account handle to detach.
   */
  detach(sessionId: string, accountId: ConnectedAccountId): void {
    const accounts = this._sessions.get(sessionId);
    if (accounts) {
      accounts.delete(accountId);
      if (accounts.size === 0) this._sessions.delete(sessionId);
    }
    this._sessionAttachments.setState(sessionId, accountId, 'detached');
  }

  /**
   * Bring a session's in-memory tool-server cache up to date with its
   * persisted connector state, exactly once per session per process
   * (connection-scoping spec §Part 1 Restart semantics). Called before a
   * session's first turn after process start.
   *
   * Computes the effective account set as
   * `(agent's standing attachments ∪ session overrides where state='attached')
   * \ (session overrides where state='detached')` — session overrides are
   * authoritative per-account, never merged with the agent's fields (the
   * Claude Code MCP ladder pattern; see design-decisions.md D2) — then
   * resolves and caches each one exactly as a live `attach` would, WITHOUT
   * writing a new session-level override row (these accounts are inherited,
   * not session-chosen; persisting one here would wrongly freeze the
   * inheritance the moment it was first read).
   *
   * A no-op for a session with no agent (agentId unresolvable) or no
   * standing/override state at all.
   *
   * @param sessionId - The session to hydrate.
   * @param agentId - The agent this session belongs to.
   */
  async hydrateSession(sessionId: string, agentId: string): Promise<void> {
    if (this._hydrated.has(sessionId)) return;
    this._hydrated.add(sessionId);

    const effective = new Set<ConnectedAccountId>(
      this._agentAttachments.listForAgent(agentId).map((a) => a.accountId)
    );
    for (const override of this._sessionAttachments.listForSession(sessionId)) {
      if (override.state === 'attached') effective.add(override.accountId);
      else effective.delete(override.accountId);
    }

    for (const accountId of effective) {
      await this._resolveAndCache(sessionId, accountId);
    }
  }

  /**
   * Resolve one account's tool-server connection and write it into the
   * in-memory cache — the shared core of {@link attach} and
   * {@link hydrateSession}. Deliberately does NOT touch either persisted
   * attachment store; callers decide whether the caller's own intent (an
   * explicit session attach) or inherited state (hydration) is being
   * recorded, if anything.
   *
   * @param sessionId - The session the account resolves into.
   * @param accountId - The opaque account handle to resolve.
   */
  private async _resolveAndCache(
    sessionId: string,
    accountId: ConnectedAccountId
  ): Promise<AttachResult | undefined> {
    const binding = this._registry.accountBinding(accountId);
    if (!binding) return undefined;

    // Route by the owning provider (server-only) and resolve the connection.
    // A provider that is no longer registered, or a null result, means the
    // account attaches but is not exposed — surfaced, never thrown.
    const provider = this._registry.resolveProvider(binding.provider);
    const connection = provider ? await provider.toolServerForAccount(accountId) : null;

    const accounts = this._ensureSession(sessionId);
    // A re-attach (e.g. re-resolving after a status change) keeps the name it was
    // first given; a fresh attach mints a stable, collision-free one.
    const existing = accounts.get(accountId);
    const serverName = existing ? existing.serverName : this._mintServerName(binding, accounts);
    accounts.set(accountId, { binding, connection, serverName });

    const account = this._statusRow(accountId, { binding, connection, serverName });
    const disclosure = disclosureForAccount(binding);
    const warning = connection ? undefined : this._warningFor(accountId, binding);
    return { account, disclosure, ...(warning && { warning }) };
  }

  /**
   * Assemble the connector tool servers for a session, synchronously from the
   * per-account cache, ready to fold into the MCP factory record. Attached
   * accounts whose cached connection is `null` are skipped and returned as
   * warnings (the null branch), never injected.
   *
   * @param sessionId - The session whose tool servers to assemble.
   */
  mcpServersForSession(sessionId: string): SessionMcpServers {
    const accounts = this._sessions.get(sessionId);
    const servers: Record<string, McpAppServerConnection> = {};
    const warnings: SessionConnectorWarning[] = [];
    if (!accounts) return { servers, warnings };

    for (const [accountId, attached] of accounts) {
      const id = accountId as ConnectedAccountId;
      if (attached.connection === null) {
        warnings.push(this._warningFor(id, attached.binding));
        continue;
      }
      servers[attached.serverName] = attached.connection;
    }
    return { servers, warnings };
  }

  /**
   * The full connector status for a session: every attached account with its
   * exposure state, plus the per-account null-branch warnings.
   *
   * @param sessionId - The session to report on.
   */
  status(sessionId: string): SessionConnectorStatus {
    const accounts = this._sessions.get(sessionId);
    const rows: SessionConnectorAccountStatus[] = [];
    const warnings: SessionConnectorWarning[] = [];
    if (!accounts) return { accounts: rows, warnings };

    for (const [accountId, attached] of accounts) {
      const id = accountId as ConnectedAccountId;
      rows.push(this._statusRow(id, attached));
      if (attached.connection === null) warnings.push(this._warningFor(id, attached.binding));
    }
    return { accounts: rows, warnings };
  }

  /**
   * Drop the cached tool-server connection of every attached account owned by
   * `providerType`, across all sessions. Called when a provider is unregistered
   * (its credential was deleted, or a reload refused it): the cached
   * connections were resolved by the now-gone instance and must not keep
   * serving. The attachments themselves survive — consent was given and a
   * re-registered provider re-resolves on the next attach — but until then each
   * account reports unexposed with the standard null-branch warning, and the
   * MCP factory stops injecting its server.
   *
   * @param providerType - The backend type whose cached connections to drop.
   */
  invalidateProvider(providerType: string): void {
    for (const accounts of this._sessions.values()) {
      for (const [accountId, attached] of accounts) {
        if (attached.binding.provider === providerType && attached.connection !== null) {
          accounts.set(accountId, { ...attached, connection: null });
        }
      }
    }
  }

  /**
   * Remove one disconnected account from every session's live cache
   * (connection-scoping spec §Part 1 Revocation). Unlike
   * {@link invalidateProvider} — which nulls the connection but keeps the
   * account attached because the PROVIDER may come back — a disconnect means
   * the account itself is gone; the caller (the connectors route) also clears
   * both persisted attachment tables via `ConnectorRegistry.recordDisconnect`,
   * so there is no standing consent left for this account to fall back to.
   *
   * @param accountId - The disconnected account to purge from every session.
   */
  invalidateAccount(accountId: ConnectedAccountId): void {
    for (const [sessionId, accounts] of this._sessions) {
      if (accounts.delete(accountId) && accounts.size === 0) {
        this._sessions.delete(sessionId);
      }
    }
  }

  /**
   * Move a session's whole attach set from an old id to a new (canonical) id.
   * Called when the runtime rekeys a brand-new session mid-first-turn (the
   * claude-code canonical-id remap): without this, an account attached under the
   * pre-remap id would be stranded — `mcpServersForSession(canonicalId)` would
   * come back empty and the tools would silently vanish. If the new id already
   * has attachments, the two sets are MERGED (an existing new-id entry wins a
   * per-account conflict, mirroring the projector rekey's "active wins"). A
   * no-op when the ids match or nothing is attached under `oldId`.
   *
   * @param oldId - The session id the accounts were attached under (request UUID).
   * @param newId - The canonical session id to move them to.
   */
  migrateSession(oldId: string, newId: string): void {
    if (oldId === newId) return;
    const from = this._sessions.get(oldId);
    if (!from) return;
    const to = this._ensureSession(newId);
    for (const [accountId, attached] of from) {
      if (!to.has(accountId)) to.set(accountId, attached);
    }
    this._sessions.delete(oldId);
  }

  /** Lazily create and return the per-account map for a session. */
  private _ensureSession(sessionId: string): Map<string, AttachedAccount> {
    let accounts = this._sessions.get(sessionId);
    if (!accounts) {
      accounts = new Map<string, AttachedAccount>();
      this._sessions.set(sessionId, accounts);
    }
    return accounts;
  }

  /** Build one attached account's session-facing status row. */
  private _statusRow(
    accountId: ConnectedAccountId,
    attached: AttachedAccount
  ): SessionConnectorAccountStatus {
    const exposed = attached.connection !== null;
    return {
      accountId,
      toolkit: attached.binding.toolkit,
      label: attached.binding.label,
      status: attached.binding.status,
      exposed,
      // Only an exposed account occupies an MCP server name in the factory.
      ...(exposed && { serverName: attached.serverName }),
    };
  }

  /**
   * Mint a stable, provider-neutral, collision-free server name for a NEW
   * attachment, checking against the names already pinned in this session (and
   * the reserved built-in names). Never recomputed later — the returned name is
   * stored on the attach record so a sibling detach cannot renumber it.
   */
  private _mintServerName(
    binding: ConnectedAccountBinding,
    accounts: Map<string, AttachedAccount>
  ): string {
    const base = baseServerName(binding.toolkit, binding.label);
    const taken = new Set<string>(RESERVED_SERVER_NAMES);
    for (const other of accounts.values()) taken.add(other.serverName);
    if (RESERVED_SERVER_NAMES.has(base)) {
      // A connector must never take a built-in server name (it would shadow the
      // built-in in the factory spread). Rename it and record the attempt.
      logger.warn(
        `[Connectors] connector server name '${base}' collides with a reserved built-in; suffixing`
      );
    }
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(`${base}-${n}`)) n += 1;
    return `${base}-${n}`;
  }

  /** Build the null-branch warning for an unexposable attached account. */
  private _warningFor(
    accountId: ConnectedAccountId,
    binding: ConnectedAccountBinding
  ): SessionConnectorWarning {
    const reason: SessionConnectorUnavailableReason =
      binding.status === 'expired' || binding.status === 'revoked' ? binding.status : 'unavailable';
    return { accountId, label: binding.label, reason };
  }
}
