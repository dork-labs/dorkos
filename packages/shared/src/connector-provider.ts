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
 * provider-neutral execution commands and results. Provider transports remain
 * confined to their adapters and never cross this port.
 *
 * See spec `specs/connector-gateway/02-specification.md` §Detailed Design 1 and
 * ADR `260718-045630` (the custody stance).
 *
 * @module shared/connector-provider
 */
import { z } from 'zod';
import type { ConnectorEventCapability } from './connector-events.js';
import {
  ConnectionIdSchema,
  ConnectorCapabilityAvailabilitySchema,
  ConnectorExternalAccountRefSchema,
  ConnectorProviderInstanceIdSchema,
  ConnectorProviderCapabilitySetSchema,
  type ConnectionId,
  type ConnectorCatalogPageRequest,
  type ConnectorExternalAccountRef,
  type ConnectorOperationPage,
  type ConnectorOperationPageRequest,
  type ConnectorProviderExecuteCommand,
  type ConnectorProviderExecuteResult,
  type ConnectorProviderInstanceId,
  type ConnectorToolkitVersionResult,
  type ConnectorUnsupportedResult,
} from './connector-schemas.js';

export { ConnectionIdSchema, ConnectorExternalAccountRefSchema, ConnectorProviderInstanceIdSchema };
export type { ConnectionId, ConnectorExternalAccountRef, ConnectorProviderInstanceId };

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
 * Stable DorkOS connection id for one account of one service. The provider's
 * own handle stays in a separate private binding. Branded so a bare string
 * cannot be passed where a connection id is due.
 */
export const ConnectedAccountIdSchema = ConnectionIdSchema;
/** Stable DorkOS id for one connected account. See {@link ConnectedAccountIdSchema}. */
export type ConnectedAccountId = ConnectionId;

/**
 * Static capability + custody descriptor for one backend (mirrors
 * `RuntimeCapabilities`). Capability flags carry genuinely-boolean backend
 * differences so there is no forked code across providers.
 */
export const ConnectorCapabilitiesSchema = z.object({
  /** Stable configured provider instance, distinct from its implementation type. */
  instanceId: ConnectorProviderInstanceIdSchema,
  /** Backend type identifier, e.g. `'composio' | 'nango' | 'mcp'`. */
  type: z.string(),
  /** Can one user hold N accounts of the same service? Raw-MCP: `false`. */
  supportsMultiAccount: z.boolean(),
  /** Custody stance — the honest disclosure the UI renders before connect. */
  custody: ConnectorCustodySchema,
  /** Capability availability declared without optimistic inference. */
  capabilities: ConnectorProviderCapabilitySetSchema,
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
  /** Exact per-service authentication availability when it differs from the provider default. */
  authentication: ConnectorCapabilityAvailabilitySchema.optional(),
  /** Composio's `max_accounts_per_toolkit`; `undefined` = unbounded/one. */
  maxAccountsPerUser: z.number().int().positive().optional(),
});
/** A connectable service. See {@link ConnectorToolkitSchema}. */
export type ConnectorToolkit = z.infer<typeof ConnectorToolkitSchema>;

/** Lifecycle status of one connected account. */
export const ConnectedAccountStatusSchema = z.enum([
  'active',
  'expired',
  'revoked',
  'pending',
  'paused',
]);
/** Lifecycle status of a connected account. See {@link ConnectedAccountStatusSchema}. */
export type ConnectedAccountStatus = z.infer<typeof ConnectedAccountStatusSchema>;

/**
 * One connected account, provider-neutral.
 *
 * `provider` is SERVER-ONLY (the registry needs it to route management and
 * brokered execution to the owning backend). It is stripped from every public
 * account view (spec §Detailed Design 2, Security).
 */
export const ConnectedAccountSchema = z.object({
  /** Stable DorkOS connection id. */
  id: ConnectedAccountIdSchema,
  /** Owning backend type — SERVER-ONLY, never in a public account DTO. */
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

/** Provider-owned account metadata before the registry assigns a stable DorkOS id. */
export const ProviderConnectedAccountSchema = ConnectedAccountSchema.omit({
  id: true,
  provider: true,
  status: true,
}).extend({
  /** Private provider account reference; the registry never returns it publicly. */
  externalAccountRef: ConnectorExternalAccountRefSchema,
  /** Provider-reported authentication state; operator pause is stored separately by DorkOS. */
  status: z.enum(['active', 'expired', 'revoked', 'pending']),
});
/** Provider-owned account metadata before stable DorkOS reconciliation. */
export type ProviderConnectedAccount = z.infer<typeof ProviderConnectedAccountSchema>;

/**
 * The reference-shaped result of beginning a connect flow. Browser-based flows
 * carry an authorization URL; flows that verify an already-configured connection
 * omit it and can be polled immediately. Secrets stay server-side and never cross
 * the port.
 */
export const ConnectStartSchema = z.object({
  /** Vendor consent screen or loopback authorize URL to open, when browser action is required. */
  authorizeUrl: z.string().url().optional(),
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
  /** `'pending'` while awaiting browser action or verification; terminal otherwise. */
  status: z.enum(['pending', 'connected', 'failed']),
  /** The new account handle, present once `status === 'connected'`. */
  account: ProviderConnectedAccountSchema.optional(),
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
 * multi-account management; and {@link execute} is the only execution path.
 */
export interface ConnectorProvider {
  /** Signed event capability when this configured provider supports reception. */
  readonly events?: ConnectorEventCapability;
  /** Stable configured instance identifier; multiple instances may share one type. */
  readonly instanceId: ConnectorProviderInstanceId;
  /** Backend type identifier; must equal `getCapabilities().type`. */
  readonly type: string;

  /** Return this backend's static capability + custody descriptor. */
  getCapabilities(): ConnectorCapabilities;

  /** Discover one bounded, cursor-addressed page of the account-free catalog. */
  listToolkitPage(
    request: ConnectorCatalogPageRequest
  ): Promise<
    | { status: 'ok'; toolkits: ConnectorToolkit[]; nextCursor?: string; truncated: boolean }
    | ConnectorUnsupportedResult
  >;

  /** Resolve the exact provider version to hold fixed through schema discovery. */
  resolveToolkitVersion(
    toolkit: string,
    signal: AbortSignal
  ): Promise<ConnectorToolkitVersionResult | ConnectorUnsupportedResult>;

  /** Discover one bounded page of immutable operation schemas. */
  listOperationSchemas(
    request: ConnectorOperationPageRequest
  ): Promise<{ status: 'ok'; page: ConnectorOperationPage } | ConnectorUnsupportedResult>;

  /** Execute one exact provider account and immutable operation revision. */
  execute(command: ConnectorProviderExecuteCommand): Promise<ConnectorProviderExecuteResult>;

  /** Discovery: which services can be connected. */
  listToolkits(): Promise<ConnectorToolkit[]>;

  /**
   * Begin connecting `toolkit`; returns a pollable flow id and, when browser
   * action is required, an authorization URL. Secrets stay server-side. A
   * single-account backend (`supportsMultiAccount: false`)
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
  listAccounts(opts?: { toolkit?: string }): Promise<ProviderConnectedAccount[]>;

  /**
   * Revoke one provider account by its private reference. Idempotent — revoking
   * an unknown/already-revoked reference resolves without throwing.
   *
   * @param externalAccountRef - The private provider account reference to disconnect.
   */
  disconnect(externalAccountRef: ConnectorExternalAccountRef): Promise<void>;
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
/**
 * Which credential KIND a provider's stored key validated as. Composio issues
 * two: project API keys (authenticate via `x-api-key`) and user-account keys
 * (`uak_…`, the CLI's kind, via `x-user-api-key`) — both work, and the setup
 * card can say which one it is using. `unknown` until a real call validates.
 */
export const ConnectorKeyKindSchema = z.enum(['project', 'user', 'unknown']);
/** Which credential kind validated. See {@link ConnectorKeyKindSchema}. */
export type ConnectorKeyKind = z.infer<typeof ConnectorKeyKindSchema>;

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
  /** Which credential kind the stored key validated as, when the provider reports it. */
  keyKind: ConnectorKeyKindSchema.optional(),
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
