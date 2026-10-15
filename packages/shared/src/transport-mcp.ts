import type { ManagedMcpServer, McpServerTransport } from './mesh-schemas.js';
import type { CapabilityTier } from './capabilities.js';
import type { DevLinkStatus } from './marketplace-schemas.js';

/** A single MCP server entry — from `.mcp.json` (config only) or live runtime status. */
export interface McpServerEntry {
  name: string;
  type: 'stdio' | 'sse' | 'http';
  /**
   * Current status reported by the owning runtime. Runtimes without MCP
   * support omit the entry entirely; see `capabilities.supportsMcp`.
   */
  status?: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  /** Error message populated when status === 'failed'. */
  error?: string;
  /**
   * Config scope — typically one of 'project' | 'user' | 'local' | 'managed'.
   * Additional runtime-specific scopes may appear; callers should treat this
   * as an open string and check `capabilities` for supported values.
   */
  scope?: string;
}

/** Response shape for the `GET /api/mcp-config` endpoint. */
export interface McpConfigResponse {
  servers: McpServerEntry[];
}

/**
 * The `202 approval_required` body a destructive capability returns when a
 * person must approve before it runs (spec `mcp-server-management` §7, spec
 * `agent-trust` §3.2). Carries the id a person decides and the one-time token
 * to present on the retry — the operator grants their own approval
 * (`grantApproval`) then retries with `approvalToken`.
 *
 * Structurally the wire contract the server's `ApprovalRequiredPayload`
 * produces; typed here so the client Transport surface can carry it without
 * importing server internals.
 */
export interface CapabilityApprovalRequired {
  /** Discriminator. Always `approval_required`. */
  status: 'approval_required';
  /** The capability that did NOT run. */
  capabilityId: string;
  /** Its human-facing title, as the operator's card shows it. */
  capabilityTitle: string;
  /** Its permission tier, from the registry. */
  tier: CapabilityTier;
  /** The approval a person will decide. Safe to show or log. */
  approvalId: string;
  /** The one-time token to present on the retry. Inert until someone grants it. */
  approvalToken: string;
  /** When the token stops being honored. ISO 8601 UTC. */
  expiresAt: string;
  /** Why the call is not running yet. */
  reason: string;
  /** One plain sentence a person can act on. */
  message: string;
  /** How to retry once approved. */
  retry: {
    /** Whether the token rides an MCP argument or an HTTP header. */
    channel: string;
    /** The exact argument or header name to put the token in. */
    field: string;
    /** Step-by-step retry instructions. */
    instructions: string;
  };
}

/**
 * Result of {@link Transport.linkDevLink}: the link was made, or the caller is
 * one the tier gate wants a person to approve first. The app is a trusted
 * caller, so it expects `linked`; the other branch is handled, not assumed away.
 */
export type DevLinkCreateResult =
  | { status: 'linked'; link: DevLinkStatus }
  | { status: 'approval_required'; approval: CapabilityApprovalRequired };

/** Input for {@link Transport.addAgentMcpServer}. */
export interface AddAgentMcpServerInput {
  /** ULID of the agent that will own the server. */
  agentId: string;
  /** Server name (unique per agent; alphanumeric, dashes, underscores). */
  name: string;
  /** How to reach the server (stdio/http/sse). */
  connection: McpServerTransport;
  /** Whether to enable it immediately. Defaults server-side to true on add. */
  enabled?: boolean;
}

/** Input for {@link Transport.importAgentMcpServer}. */
export interface ImportAgentMcpServerInput {
  /** ULID of the agent that will own the imported server. */
  agentId: string;
  /** The discovered server's name (its key in the project's `.mcp.json`). */
  name: string;
}

/** Input for {@link Transport.updateAgentMcpServer}. */
export interface UpdateAgentMcpServerInput {
  /** ULID of the agent that owns the server. */
  agentId: string;
  /** Name of the existing server to update. */
  name: string;
  /** New connection. Omit to leave it unchanged; changing it re-prompts approval. */
  connection?: McpServerTransport;
  /** New enabled state. Omit to leave it unchanged. */
  enabled?: boolean;
}

/**
 * Result of a destructive managed-MCP mutation ({@link Transport.addAgentMcpServer},
 * {@link Transport.updateAgentMcpServer}): either the write ran and the updated
 * list came back, or it is parked waiting on a person's approval.
 */
export type AgentMcpMutationResult =
  | { status: 'ok'; servers: ManagedMcpServer[] }
  | { status: 'approval_required'; approval: CapabilityApprovalRequired };

/** Result of probing a managed MCP server ({@link Transport.testAgentMcpServer}). */
export interface AgentMcpTestResult {
  /** Whether the server connected and listed its tools. */
  ok: boolean;
  /** How many tools it exposes, when reachable. */
  toolCount?: number;
  /** The failure reason, when unreachable. */
  error?: string;
  /**
   * True when the probe failed specifically because the server demands OAuth
   * sign-in (a 401 / unauthorized response), so the client can render
   * "Needs sign-in" and offer the sign-in action rather than the raw error
   * (DOR-942). Absent for reachable servers and for non-auth failures.
   */
  needsAuth?: boolean;
}

/**
 * Result of starting an OAuth sign-in for a managed MCP server (the `mcp.signin`
 * capability, DOR-943). The client shows {@link disclosure} verbatim, then opens
 * {@link authorizeUrl} in a new tab and polls {@link Transport.pollMcpSignin}
 * with {@link flowId}. When a live token already existed, {@link alreadyConnected}
 * is true and {@link authorizeUrl} is absent — no browser step is needed.
 */
export interface StartMcpSigninResult {
  /** The sign-in flow id to pass to {@link Transport.pollMcpSignin}. */
  flowId: string;
  /** The sign-in link to open in a new tab; absent when {@link alreadyConnected}. */
  authorizeUrl?: string;
  /** True when a live token already existed, so no browser step is needed. */
  alreadyConnected: boolean;
  /** The custody disclosure to show verbatim before opening the link. */
  disclosure: string;
  /** Ready-to-render markdown carrying the link and disclosure (agent-facing surfaces). */
  message: string;
}

/**
 * Why a managed-MCP sign-in could not even be STARTED (DOR-982) — the `code` on
 * the error payload `mcp.signin` rejects with, so every surface can say the same
 * plain sentence instead of relaying an OAuth stack trace.
 *
 * - `SIGNIN_NO_APP_REGISTRATION` — the provider will not let DorkOS register
 *   itself automatically. This is the one a person can fix: they can paste app
 *   credentials from the provider's developer settings
 *   ({@link Transport.setMcpClientCredentials}) and sign in again.
 * - `SIGNIN_NO_SIGNIN_SUPPORT` — the server publishes no OAuth details DorkOS
 *   can work from, so there is no sign-in to start.
 * - `SIGNIN_UNREACHABLE` — everything else: the server could not be reached, or
 *   it answered in a way DorkOS could not use.
 *
 * The raw error is carried alongside as `detail`, for the Details disclosure —
 * it is never the headline.
 */
export const MCP_SIGNIN_FAILURE_CODES = [
  'SIGNIN_NO_APP_REGISTRATION',
  'SIGNIN_NO_SIGNIN_SUPPORT',
  'SIGNIN_UNREACHABLE',
] as const;

/** See {@link MCP_SIGNIN_FAILURE_CODES}. */
export type McpSigninFailureCode = (typeof MCP_SIGNIN_FAILURE_CODES)[number];

/**
 * The app credentials an operator got from a provider that does not support
 * automatic client registration (DOR-982).
 *
 * Both values are secrets in the same sense a token is: they are stored
 * encrypted on this computer, never written to the manifest, never logged, and
 * never handed back out — no read side exists for them at all.
 */
export interface McpClientCredentials {
  /** The client id (sometimes "app id") the provider issued. */
  clientId: string;
  /** The client secret, when the provider issued one. Many public clients have none. */
  clientSecret?: string;
}

/** The pollable status of a managed-MCP sign-in flow (the `mcp.poll_signin` capability). */
export interface McpSigninPollResult {
  /** Whether the sign-in is still waiting, finished, or failed. */
  status: 'pending' | 'connected' | 'failed';
  /** The failure reason, when {@link status} is `failed`. */
  error?: string;
  /**
   * How many tools the server exposes, counted right after the sign-in landed
   * (DOR-1003) — the payoff line, "Connected — 12 tools."
   *
   * Present only when {@link status} is `connected` AND the server answered the
   * follow-up probe. Absent never means zero, so read it defensively: a
   * connection is reported whether or not the count could be taken.
   */
  toolCount?: number;
}
