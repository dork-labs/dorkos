/**
 * The `ConnectorProvider` port — one provider-neutral contract for connecting a
 * DorkOS agent to real third-party services (Gmail, Slack, Notion, …) and
 * acting for the user, including two accounts of the SAME service.
 *
 * This is the THIRD swappable seam beside {@link ./agent-runtime.js | AgentRuntime}
 * and {@link ./transport.js | Transport}: one port, N backends
 * (Composio managed, Nango self-host, a raw-MCP baseline), a server-side
 * registry, capability flags, and a shared conformance suite that gates every
 * implementation exactly as `runtimeConformance` gates runtimes.
 *
 * Schemas are the authoritative contract (the repo is Zod-first); TS types
 * derive via `z.infer`. The port interface itself is a runtime port (not a
 * serializable DTO), so it is a TS interface over the derived types, reusing the
 * existing {@link McpAppServerConnection} — connected tools always reach a
 * session through the one MCP seam, never a new mechanism.
 *
 * See spec `specs/connector-gateway/02-specification.md` §Detailed Design 1 and
 * ADR `260718-045630` (the custody stance).
 *
 * @module shared/connector-provider
 */
import { z } from 'zod';
import type { McpAppServerConnection } from './agent-runtime.js';

/**
 * Where a provider keeps end-user OAuth tokens at rest — the field that drives
 * the plain-language custody disclosure shown before connect (spec §4).
 *
 * - `managed` — vendor cloud vault (Composio): tokens leave the machine.
 * - `self-host` — the operator's own store (self-hosted Nango, your Postgres):
 *   tokens stay in infrastructure you control.
 * - `external` — no token custody by the gateway (raw MCP): the remote server
 *   holds its own credentials.
 */
export const ConnectorCustodySchema = z.enum(['managed', 'self-host', 'external']);
/** Where a provider keeps end-user OAuth tokens at rest. See {@link ConnectorCustodySchema}. */
export type ConnectorCustody = z.infer<typeof ConnectorCustodySchema>;

/**
 * Opaque, provider-scoped handle for ONE account of one service — the addressing
 * primitive raw MCP lacks. A backend maps it to its own handle (Composio's
 * `ca_…`, Nango's `connectionId`); the session tool surface never sees the
 * vendor. Branded so a bare string cannot be passed where an account id is due.
 */
export const ConnectedAccountIdSchema = z.string().min(1).brand('ConnectedAccountId');
/** Opaque, provider-scoped id for one connected account. See {@link ConnectedAccountIdSchema}. */
export type ConnectedAccountId = z.infer<typeof ConnectedAccountIdSchema>;

/**
 * Static capability + custody descriptor for one backend (mirrors
 * `RuntimeCapabilities`). Capability flags carry genuinely-boolean backend
 * differences so there is no forked code across providers.
 */
export const ConnectorCapabilitiesSchema = z.object({
  /** Backend type identifier, e.g. `'composio' | 'nango' | 'mcp'`. */
  type: z.string(),
  /** Can one user hold N accounts of the same service? Raw-MCP: `false`. */
  supportsMultiAccount: z.boolean(),
  /** Custody stance — the honest disclosure the UI renders before connect. */
  custody: ConnectorCustodySchema,
  /** Can the backend expose connected tools to a session over MCP? */
  exposesOverMcp: z.boolean(),
  /** Backend-specific metadata that doesn't merit a first-class field (cf. `RuntimeCapabilities.features`). */
  features: z.record(z.string(), z.unknown()).default(() => ({})),
});
/** Static capability + custody descriptor for one backend. See {@link ConnectorCapabilitiesSchema}. */
export type ConnectorCapabilities = z.infer<typeof ConnectorCapabilitiesSchema>;

/** How a toolkit authenticates the user when connecting an account. */
export const ConnectorAuthKindSchema = z.enum(['oauth2', 'api-key', 'none']);
/** How a toolkit authenticates the user. See {@link ConnectorAuthKindSchema}. */
export type ConnectorAuthKind = z.infer<typeof ConnectorAuthKindSchema>;

/** A service the provider can connect to (Gmail, Slack, …). */
export const ConnectorToolkitSchema = z.object({
  /** Stable service slug, e.g. `'gmail'`. */
  slug: z.string(),
  /** Human-facing service name shown in the connect picker. */
  displayName: z.string(),
  /** How the user authenticates when connecting this toolkit. */
  authKind: ConnectorAuthKindSchema,
  /** Composio's `max_accounts_per_toolkit`; `undefined` = unbounded/one. */
  maxAccountsPerUser: z.number().int().positive().optional(),
});
/** A connectable service. See {@link ConnectorToolkitSchema}. */
export type ConnectorToolkit = z.infer<typeof ConnectorToolkitSchema>;

/** Lifecycle status of one connected account. */
export const ConnectedAccountStatusSchema = z.enum(['active', 'expired', 'revoked', 'pending']);
/** Lifecycle status of a connected account. See {@link ConnectedAccountStatusSchema}. */
export type ConnectedAccountStatus = z.infer<typeof ConnectedAccountStatusSchema>;

/**
 * One connected account, provider-neutral.
 *
 * `provider` is SERVER-ONLY (the registry needs it to route
 * `toolServerForAccount`/`disconnect` to the owning backend); it is stripped
 * from any session-facing view — the session tool surface never sees which
 * vendor is behind a connection (spec §Detailed Design 2, Security).
 */
export const ConnectedAccountSchema = z.object({
  /** Opaque, provider-scoped account handle. */
  id: ConnectedAccountIdSchema,
  /** Owning backend type — SERVER-ONLY, never in the session tool surface. */
  provider: z.string(),
  /** Service slug this account belongs to, e.g. `'gmail'`. */
  toolkit: z.string(),
  /** User-facing disambiguator, e.g. `'dorian@personal'` (Composio alias / Nango tag). */
  label: z.string(),
  /** Lifecycle status. */
  status: ConnectedAccountStatusSchema,
  /** Echoes the provider custody stance so each row can disclose per-account (spec §4). */
  custody: ConnectorCustodySchema,
});
/** One connected account, provider-neutral. See {@link ConnectedAccountSchema}. */
export type ConnectedAccount = z.infer<typeof ConnectedAccountSchema>;

/**
 * The reference-shaped result of beginning a connect flow — mirrors
 * `startOpenRouterOAuth`'s loopback-PKCE shape. Carries only a URL and an opaque
 * flow id to poll; `code_verifier`/secrets stay server-side and never cross the
 * port.
 */
export const ConnectStartSchema = z.object({
  /** Vendor consent screen or loopback authorize URL to open. */
  authorizeUrl: z.string().url(),
  /** Opaque flow id to poll with {@link ConnectorProvider.pollConnect}. */
  flowId: z.string().min(1),
});
/** Result of beginning a connect flow. See {@link ConnectStartSchema}. */
export type ConnectStart = z.infer<typeof ConnectStartSchema>;

/**
 * The pollable state of a connect flow. Failure is TYPED (`status: 'failed'`
 * with an `error` message), never thrown across the port — callers branch on
 * `status`, they do not catch.
 */
export const ConnectPollSchema = z.object({
  /** `'pending'` while awaiting consent; terminal `'connected'` or `'failed'`. */
  status: z.enum(['pending', 'connected', 'failed']),
  /** The new account handle, present once `status === 'connected'`. */
  account: ConnectedAccountSchema.optional(),
  /** Failure detail, present on `status === 'failed'` — failure-typed, never thrown. */
  error: z.string().optional(),
});
/** Pollable state of a connect flow. See {@link ConnectPollSchema}. */
export type ConnectPoll = z.infer<typeof ConnectPollSchema>;

/**
 * Universal connector backend contract — the third swappable seam beside
 * `AgentRuntime` and `Transport`. Composio (managed), Nango (self-host), and a
 * raw-MCP adapter (baseline) each implement it; a shared conformance suite
 * (`connectorConformance` in `@dorkos/test-utils`) gates every one, exactly as
 * `runtimeConformance` gates runtimes.
 *
 * Every method earns its place: discovery (`listToolkits`) drives the connect
 * picker; `startConnect`/`pollConnect` are the reference-not-secret connect flow
 * (the `Transport` PKCE-loopback pair); `listAccounts`/`disconnect` are
 * multi-account management; `toolServerForAccount` is the single unification
 * point — every provider ultimately exposes tools as MCP, so its output plugs
 * straight into `setMcpServerFactory`.
 */
export interface ConnectorProvider {
  /** Backend type identifier; must equal `getCapabilities().type`. */
  readonly type: string;

  /** Return this backend's static capability + custody descriptor. */
  getCapabilities(): ConnectorCapabilities;

  /** Discovery: which services can be connected. */
  listToolkits(): Promise<ConnectorToolkit[]>;

  /**
   * Begin connecting `toolkit`; returns a URL + pollable flow id (secrets stay
   * server-side). A single-account backend (`supportsMultiAccount: false`)
   * rejects a second connect of an already-connected toolkit rather than
   * creating a duplicate.
   *
   * @param toolkit - Service slug to connect (must appear in `listToolkits`).
   * @param opts - Optional connect options; `label` disambiguates multiple accounts.
   */
  startConnect(toolkit: string, opts?: { label?: string }): Promise<ConnectStart>;

  /**
   * Poll a connect flow to completion; resolves to the new account handle.
   * Failure is TYPED on the result (`status: 'failed'`), never thrown.
   *
   * @param flowId - The opaque flow id from {@link startConnect}.
   */
  pollConnect(flowId: string): Promise<ConnectPoll>;

  /**
   * Multi-account addressing: list every account the user holds, optionally
   * filtered to one service.
   *
   * @param opts - Optional filter; `toolkit` narrows to one service slug.
   */
  listAccounts(opts?: { toolkit?: string }): Promise<ConnectedAccount[]>;

  /**
   * Revoke one account by its opaque id. Idempotent — revoking an
   * unknown/already-revoked id resolves without throwing.
   *
   * @param accountId - The opaque account handle to disconnect.
   */
  disconnect(accountId: ConnectedAccountId): Promise<void>;

  /**
   * Expose a connected account's tools to a session as MCP. Returns
   * runtime-neutral connection details (the exact {@link McpAppServerConnection}
   * the runtime already injects), selected BY id — so two Gmail accounts become
   * two addressable tool servers.
   *
   * Returns `null` when the account cannot be exposed right now: `expired`/
   * `revoked` status, a provider that momentarily has no live session URL, or a
   * transport this host cannot independently reconnect. Callers MUST handle
   * `null` (spec §Detailed Design 3) — it is a surfaced, per-account warning,
   * never a thrown error and never a silent drop. This mirrors
   * `AgentRuntime.getMcpServerConfig?`, which is itself optional and nullable
   * (`agent-runtime.ts`).
   *
   * @param accountId - The opaque account handle to expose.
   */
  toolServerForAccount(accountId: ConnectedAccountId): Promise<McpAppServerConnection | null>;
}

/**
 * One credential-gated provider's setup state, as reported by
 * `GET /api/connectors/providers` (connector-completion spec §Detailed Design 1).
 *
 * Deliberately reference-free: no field may carry a secret OR a credential
 * reference — the DTO is booleans, the custody stance, its plain-language
 * disclosure line, and (when a configured provider refused to register) the
 * honest error text, e.g. the Nango encryption-key refusal.
 */
export const ConnectorProviderStatusSchema = z.object({
  /** Backend type identifier, e.g. `'composio' | 'nango'`. */
  type: z.string(),
  /** Whether the provider's credential (and any required env) is present. */
  configured: z.boolean(),
  /** Whether the provider is currently registered and serving. */
  registered: z.boolean(),
  /** Custody stance — drives the setup card's disclosure line. */
  custody: ConnectorCustodySchema,
  /** Plain-language custody disclosure for this provider (server-owned copy). */
  disclosure: z.string(),
  /** Why a configured provider is not registered (secret-free), when it isn't. */
  error: z.string().optional(),
});
/** One provider's setup state. See {@link ConnectorProviderStatusSchema}. */
export type ConnectorProviderStatus = z.infer<typeof ConnectorProviderStatusSchema>;

/**
 * How a service should be connected, in precedence order — the output kind of
 * `recommendConnector` (spec §Detailed Design 5).
 *
 * - `relay-adapter` — a purpose-built relay adapter exists for this service
 *   (bidirectional messaging + consent binding); the richest option.
 * - `gateway` — a {@link ConnectorProvider} gateway backend (Composio managed /
 *   Nango self-host) that lists the service as a toolkit.
 * - `raw-mcp` — a known remote MCP server for this service (single-account
 *   baseline).
 */
export const ConnectorRecommendationKindSchema = z.enum(['relay-adapter', 'gateway', 'raw-mcp']);
/** How a service should be connected. See {@link ConnectorRecommendationKindSchema}. */
export type ConnectorRecommendationKind = z.infer<typeof ConnectorRecommendationKindSchema>;

/**
 * One ranked way to connect a service — the routing surface the "Connect to
 * Slack" (relay-adapter-first) and "Connect to my Gmail" (gateway) W4 evals
 * assert against. `recommendConnector` returns these sorted ascending by
 * `rank` (0 = best).
 */
export const ConnectorRecommendationSchema = z.object({
  /** Which mechanism this recommendation routes to. */
  kind: ConnectorRecommendationKindSchema,
  /** Service slug this recommendation is for, e.g. `'slack' | 'gmail'`. */
  target: z.string(),
  /** Relay adapter type, or `'composio' | 'nango'` for a gateway; absent for raw-mcp. */
  provider: z.string().optional(),
  /** Sort key — `0` is best; recommendations are returned ascending. */
  rank: z.number().int().nonnegative(),
  /** Plain-language "why this one", shown in the connect picker. */
  reason: z.string(),
  /** Custody stance, present for `gateway`/`raw-mcp` so the picker can disclose before connect. */
  custody: ConnectorCustodySchema.optional(),
});
/** One ranked way to connect a service. See {@link ConnectorRecommendationSchema}. */
export type ConnectorRecommendation = z.infer<typeof ConnectorRecommendationSchema>;

// ---------------------------------------------------------------------------
// Client-facing DTOs (connector-completion spec §Detailed Design 5)
//
// The response shapes of the connector REST routes, shared so the Transport
// methods, the client hooks, and the server routes agree by construction. All
// deliberately reference-free: no secret, no credential reference, and never a
// `McpAppServerConnection` — the client sees account metadata, statuses, and
// server-owned disclosure copy only.
// ---------------------------------------------------------------------------

/**
 * One provider's aggregation-degradation notice — a backend that failed or
 * timed out while a cross-provider listing was assembled (ADR-0310 pattern).
 */
export const ConnectorWarningSchema = z.object({
  /** The backend type that degraded, e.g. `'composio'`. */
  provider: z.string(),
  /** Human-readable reason the provider's results are missing from the aggregate. */
  message: z.string(),
});
/** One provider's degradation notice. See {@link ConnectorWarningSchema}. */
export type ConnectorWarning = z.infer<typeof ConnectorWarningSchema>;

/**
 * A connected account as it crosses ANY outward surface (client, agent tools):
 * the server-only `provider` field stripped, and the server-composed
 * plain-language custody sentence attached — no client or agent surface ever
 * composes disclosure copy of its own (ADR `260718-045630`).
 */
export const PublicConnectedAccountSchema = ConnectedAccountSchema.omit({ provider: true }).extend({
  /** This account's plain-language custody sentence, composed server-side. */
  disclosure: z.string(),
});
/** A client/agent-facing connected account. See {@link PublicConnectedAccountSchema}. */
export type PublicConnectedAccount = z.infer<typeof PublicConnectedAccountSchema>;

/** Response of `GET /api/connectors/toolkits`. */
export const ConnectorToolkitsResponseSchema = z.object({
  /** Every connectable toolkit from every reachable provider, deduped by slug. */
  toolkits: z.array(ConnectorToolkitSchema),
  /** One entry per provider that failed or timed out (never a hard failure). */
  warnings: z.array(ConnectorWarningSchema),
});
/** Aggregated toolkits + degradation warnings. See {@link ConnectorToolkitsResponseSchema}. */
export type ConnectorToolkitsResponse = z.infer<typeof ConnectorToolkitsResponseSchema>;

/** Response of `GET /api/connectors/recommend?service=…`. */
export const ConnectorRecommendationsResponseSchema = z.object({
  /** Applicable connection routes, sorted ascending by precedence (best first). */
  recommendations: z.array(ConnectorRecommendationSchema),
  /** One entry per provider that degraded during the toolkit scan. */
  warnings: z.array(ConnectorWarningSchema),
});
/** Routed recommendations + warnings. See {@link ConnectorRecommendationsResponseSchema}. */
export type ConnectorRecommendationsResponse = z.infer<
  typeof ConnectorRecommendationsResponseSchema
>;

/** Response of `GET /api/connectors/accounts`. */
export const ConnectorAccountsResponseSchema = z.object({
  /** Every account from every reachable provider, each with its custody sentence. */
  accounts: z.array(PublicConnectedAccountSchema),
  /** One entry per provider that failed or timed out (never a hard failure). */
  warnings: z.array(ConnectorWarningSchema),
});
/** Aggregated accounts + warnings. See {@link ConnectorAccountsResponseSchema}. */
export type ConnectorAccountsResponse = z.infer<typeof ConnectorAccountsResponseSchema>;

/**
 * Response of `POST /api/connectors/:provider/connect` — the reference-shaped
 * flow start plus the custody disclosure the UI MUST render before the auth
 * URL is opened (disclosure-before-URL is a consent invariant, not styling).
 */
export const ConnectorConnectStartResponseSchema = ConnectStartSchema.extend({
  /** The custody sentence to show BEFORE opening {@link ConnectStart.authorizeUrl}. */
  disclosure: z.string(),
});
/** Flow start + pre-connect disclosure. See {@link ConnectorConnectStartResponseSchema}. */
export type ConnectorConnectStartResponse = z.infer<typeof ConnectorConnectStartResponseSchema>;

/**
 * Response of `GET /api/connectors/flows/:flowId` — {@link ConnectPollSchema}
 * with the account in its public (provider-stripped, disclosure-carrying) form.
 */
export const ConnectorConnectPollResponseSchema = z.object({
  /** `'pending'` while awaiting consent; terminal `'connected'` or `'failed'`. */
  status: z.enum(['pending', 'connected', 'failed']),
  /** The new account, present once `status === 'connected'`. */
  account: PublicConnectedAccountSchema.optional(),
  /** Failure detail, present on `status === 'failed'` — failure-typed, never thrown. */
  error: z.string().optional(),
});
/** Pollable public flow state. See {@link ConnectorConnectPollResponseSchema}. */
export type ConnectorConnectPollResponse = z.infer<typeof ConnectorConnectPollResponseSchema>;

/**
 * Why an attached account is not currently exposed as a tool server — the
 * surfaced form of the `toolServerForAccount` null branch (never a throw,
 * never a silent drop).
 */
export const SessionConnectorUnavailableReasonSchema = z.enum([
  'expired',
  'revoked',
  'unavailable',
]);
/** Null-branch reason. See {@link SessionConnectorUnavailableReasonSchema}. */
export type SessionConnectorUnavailableReason = z.infer<
  typeof SessionConnectorUnavailableReasonSchema
>;

/** A per-account notice that an attached account could not be exposed right now. */
export const SessionConnectorWarningSchema = z.object({
  /** The attached account this warning is about. */
  accountId: ConnectedAccountIdSchema,
  /** The account's user-facing label, for a "reconnect {label}" affordance. */
  label: z.string(),
  /** Why it is not exposed (drives the reconnect prompt copy). */
  reason: SessionConnectorUnavailableReasonSchema,
});
/** One null-branch warning. See {@link SessionConnectorWarningSchema}. */
export type SessionConnectorWarning = z.infer<typeof SessionConnectorWarningSchema>;

/** One attached account's status in a session's connector surface. */
export const SessionConnectorAccountStatusSchema = z.object({
  /** The attached account id. */
  accountId: ConnectedAccountIdSchema,
  /** Service slug, e.g. `'gmail'`. */
  toolkit: z.string(),
  /** User-facing label, e.g. `'work'`. */
  label: z.string(),
  /** Lifecycle status echoed from the routing binding. */
  status: ConnectedAccountStatusSchema,
  /** The provider-neutral MCP server name this account is exposed under, when exposed. */
  serverName: z.string().optional(),
  /** Whether the account is currently exposed as a tool server. */
  exposed: z.boolean(),
});
/** One attached account's session status. See {@link SessionConnectorAccountStatusSchema}. */
export type SessionConnectorAccountStatus = z.infer<typeof SessionConnectorAccountStatusSchema>;

/**
 * Response of `GET /api/sessions/:id/connectors` — the session's connector
 * surface: what is attached, and what degraded.
 */
export const SessionConnectorStatusSchema = z.object({
  /** Every account attached to this session, each with its exposure state. */
  accounts: z.array(SessionConnectorAccountStatusSchema),
  /** Per-account warnings for attached accounts that could not be exposed. */
  warnings: z.array(SessionConnectorWarningSchema),
});
/** One session's connector surface. See {@link SessionConnectorStatusSchema}. */
export type SessionConnectorStatus = z.infer<typeof SessionConnectorStatusSchema>;

/**
 * Response of `POST /api/sessions/:id/connectors/:accountId` — the consent
 * point's receipt: the attached account's row, the custody disclosure re-shown
 * at attach, and the null-branch warning when the account attached but is not
 * exposable right now.
 */
export const SessionConnectorAttachResultSchema = z.object({
  /** The attached account's session-facing status row. */
  account: SessionConnectorAccountStatusSchema,
  /** The custody disclosure to re-show at the consent point. */
  disclosure: z.string(),
  /** Present when the account attached but is not exposable right now (null branch). */
  warning: SessionConnectorWarningSchema.optional(),
});
/** The attach receipt. See {@link SessionConnectorAttachResultSchema}. */
export type SessionConnectorAttachResult = z.infer<typeof SessionConnectorAttachResultSchema>;
