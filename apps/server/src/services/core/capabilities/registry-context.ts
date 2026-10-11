import type { Db } from '@dorkos/db';
import type { ConnectorRuntimePrincipalService } from '../../connectors/principal/runtime-principal-service.js';
import type { RoomMergeService } from '../../rooms/repo/room-merge-service.js';
import type { ApprovalServiceAction } from '@dorkos/shared/approval-schemas';
import type { McpServerId } from '@dorkos/shared/capabilities';
import type { AgentIdentity } from '../agent-identity/agent-identity-service.js';
import type { ApprovalRetryChannel, GrantedApproval } from './tier-enforcement.js';
import type { TrustedCaller } from './trusted-caller.js';
import type { ServerPrincipalProof } from '../../connectors/principal/server-principal.js';
import type { CapabilityAuthorityBindingProof } from '../../connectors/principal/capability-authority-binding.js';
import type { CapabilityDefinition } from './capability-definition.js';

/**
 * What a transport adapter supplies to {@link CapabilityRegistry.invoke}.
 *
 * Threaded from whichever surface received the call (the invoke route, an MCP
 * server, a cockpit route) down to the registry, which is the single choke point
 * every surface funnels through — so the tier gate runs once, here, and
 * attribution is recorded once, here, rather than duplicated into every adapter.
 *
 * Note what this interface does NOT carry: a granted approval. That is the
 * registry's OWN conclusion, produced by the gate it runs, and a caller supplying
 * it would be handing the handler a person's consent nobody gave. Handlers read
 * it off {@link CapabilityHandlerContext} instead.
 */
export interface CapabilityInvocationContext {
  /**
   * The agent behind this call, when one presented a resolved identity token.
   * `undefined` means the human operator or an unattributed client, which is
   * the normal case and does not change whether the gate runs — the capability's
   * TIER decides that (see `tier-enforcement.ts`).
   */
  identity?: AgentIdentity;
  /**
   * Whether the caller claimed to be a machine AT ALL — resolved or not.
   *
   * The wider question than {@link identity}, and a different one: that field
   * answers "WHICH agent is this", which needs a token that verified; this
   * answers "is a machine calling", which a token that did NOT verify still
   * says. It is the same fact `middleware/agent-identity.ts` exposes as
   * `presentsAgentIdentity`, threaded here so the two HTTP surfaces
   * (`routes/capabilities-invoke.ts`, `routes/mcp.ts`) can state it — an
   * in-process surface resolves its caller structurally and leaves it absent.
   *
   * **It exists because absent {@link identity} was doing double duty.** A
   * revoked or expired agent presents a token that resolves to nothing, so it
   * arrived as "nobody this surface could name" — indistinguishable from the
   * person at the keyboard, whom `room-capabilities.ts` answers with the install
   * owner when login is off. That made `post_to_room` write as the operator and
   * `read_room_history` read the operator's rooms (DOR-1361). It changes no tier
   * decision: the gate deliberately never keys on whether a caller identified
   * itself, and an unidentified caller already gets the anonymous ceiling.
   */
  agentIdentityPresented?: boolean;
  /**
   * Proof that this caller may decide approvals, and may therefore act without
   * one — the single, unforgeable way past the gate. Only `trusted-caller.ts` can
   * mint it, and only from the same check that guards the decide endpoint.
   *
   * Supplying this together with {@link identity} is a contradiction and is
   * refused; see the module TSDoc of `trusted-caller.ts`.
   */
  trusted?: TrustedCaller;
  /**
   * The approval token the caller presented on a retry, when it presented one.
   *
   * It travels beside the input rather than inside it, because the approval binds
   * to a hash of the input and a token carried as an input field would change the
   * very hash it is checked against.
   */
  approvalToken?: string;
  /**
   * Which channel a retry should carry its approval token on, so the gate's
   * instructions name the right field for the surface the call arrived on.
   *
   * Defaults to `http-header`, correct for every HTTP surface. An MCP adapter
   * MUST pass `mcp-argument`, or it will tell a model to set a header it has no
   * way to set.
   */
  retryChannel?: ApprovalRetryChannel;
  /**
   * Set only by the `request_permission` handler, on its own re-invocation of the
   * action the agent asked for: the agent is deliberately asking past a Blocked
   * permission, with this reason (spec `agent-permissions` D8). Forwarded to the
   * gate and nowhere else. No surface reads it off the wire; each builds this
   * context field by field.
   */
  blockedRequest?: { reason: string };
  /**
   * The signed-in PERSON behind this call, when login is on and the surface
   * verified one — a session cookie or a per-user API key.
   *
   * It exists because "no agent identity" is not the same fact as "the owner".
   * A capability that acts on somebody's own data (the rooms domain reads and
   * writes rooms scoped to one member) has to know WHICH person is asking, and
   * the honest answers are three, not two: an agent, a named person, or nobody
   * this surface could name. Resolving the third case to the owner is how an
   * invited user's API key came to read the owner's direct messages.
   *
   * Absent when login is off — where there is genuinely nothing to tell a local
   * program from the person at the keyboard (the documented DOR-505 residual) —
   * and absent on any surface that verifies no person. Informational, never an
   * authorization: it says who the caller is, not what they may do.
   */
  userId?: string;
  /**
   * The session the call was made FROM, when the surface has one — the
   * in-session `dorkos` server sets it from the live session (connector
   * capabilities default their session-scoped actions to it). The external
   * `/mcp` and HTTP surfaces have no invoking session and leave it absent, so a
   * handler that needs one must then be told explicitly. An adapter fact like
   * {@link identity}: informational, never an authorization.
   */
  sessionId?: string;
  /**
   * The working directory that session runs in, when the surface has one.
   *
   * Set beside {@link sessionId} and by the same surface, for handlers that must
   * record WHERE a session lives rather than merely which one it is — a sign-in
   * that outlives the process has to be resumable in the right directory after a
   * restart has taken the live session with it (DOR-981). Informational, never an
   * authorization: it says where the caller is, not what it may do.
   */
  cwd?: string;
  /** Process-authenticated caller resolved by a server-owned boundary. */
  /**
   * Which MCP server's tool list this call arrived through, set by the MCP
   * projections; absent on HTTP and the CLI. Informational: it decides no
   * tier. The request tool uses it to reach only actions this same surface
   * lists (spec `agent-permissions` D8).
   */
  mcpServer?: McpServerId;
  serverPrincipal?: ServerPrincipalProof;
  /** Abort only this capability call; never reused as a turn-lifetime signal. */
  signal?: AbortSignal;
  /**
   * Stable agent deliberately selected by a verified program connector route.
   *
   * This is server-derived adapter context, never part of a public capability
   * input and never forwarded by an MCP projection. Runtime principals already
   * carry their canonical agent and therefore cannot set it.
   */
  connectorAgentId?: string;
  /** Server-known connector entry surface used only for immutable usage attribution. */
  connectorSurface?: 'mcp' | 'rest' | 'cli';
  /**
   * The hand-registered tools the calling MCP server built, handed on only to a
   * `forwardsApproval` capability (the request tool). See {@link HandToolReach}.
   */
  handTools?: HandToolReach;
}

/** Live domain authorization resolved between parsing and tier approval. */
export interface CapabilityPreflightResult {
  /** Process-authenticated binding over authority, target, and parsed input. */
  readonly authorityBinding: CapabilityAuthorityBindingProof;
  /**
   * What a connected-app action would do, for its approval card (DOR-2504).
   * Built by the preflight from the stored records it just checked, so the
   * card's app, account and action are the server's, never the caller's.
   */
  readonly approvalServiceAction?: ApprovalServiceAction;
}

/**
 * The hand-registered MCP tools one MCP server built, reachable by the request
 * tool (`permissions.request_access`) even when a Blocked permission left them
 * out of the list the agent sees (spec `agent-permissions` D8).
 *
 * Built by the two servers that register hand tools (claude-code's in-session
 * server and the external `/mcp` server) and handed only to the request tool.
 * `request` runs the tool through the same tier gate a direct call does, marked
 * as a deliberate request past Blocked, so the person is asked about exactly
 * this tool and these arguments.
 */
export interface HandToolReach {
  /** Whether this server built a hand-registered tool by this bare name. */
  has(name: string): boolean;
  /**
   * Run one hand-registered tool as a request past Blocked.
   *
   * @param name - The bare tool name.
   * @param args - The exact arguments the agent would call it with.
   * @param options - Who is asking, why, and the token a retry presents.
   * @returns The tool's own result.
   * @throws {CapabilityGateRefusal} When the gate did not let it run (a card was
   *   raised, or it was refused), so the in-session hold can wait on it.
   */
  request(
    name: string,
    args: Record<string, unknown>,
    options: { identity: AgentIdentity; reason: string; approvalToken?: string }
  ): Promise<unknown>;
}

/**
 * What a capability's handler receives — who is calling, and what the gate
 * already concluded about this exact call.
 *
 * Deliberately a different type from {@link CapabilityInvocationContext}: the
 * fields a caller may SUPPLY and the fields a handler may TRUST are not the same
 * set, and collapsing them is how a shared, memoized adapter context once
 * forwarded an `approval` the gate never granted.
 */
export interface CapabilityHandlerContext {
  /** The agent behind this call, when one presented a resolved identity token. */
  identity?: AgentIdentity;
  /**
   * Whether a machine claimed this call at all, resolved or not. See
   * {@link CapabilityInvocationContext.agentIdentityPresented} — a handler that
   * resolves the caller to a domain principal must refuse when this holds and
   * {@link identity} does not, rather than reading the pair as "no agent".
   */
  agentIdentityPresented?: boolean;
  /**
   * The signed-in person behind this call, when the surface verified one. See
   * {@link CapabilityInvocationContext.userId} for why its ABSENCE is a distinct
   * fact from "the owner" and must be treated as one.
   */
  userId?: string;
  /**
   * The approval the tier gate spent to let this call through, when the call was
   * gated (`destructive` tier) and a person granted it.
   *
   * Set by the registry, never by a caller. A capability whose handler runs its
   * own confirmation flow treats this as consent already given for this exact
   * invocation, so the operator answers one card instead of two.
   */
  approval?: GrantedApproval;
  /**
   * For a capability with `describeApprovalChange`: the description the gate
   * computed and let through, which is exactly the text the person approved
   * when an approval was spent (DOR-2696). Set by the registry, never by a
   * caller. A handler that acts on what the card showed acts on THIS text
   * rather than reading the state again, which could have moved since.
   */
  approvedChange?: string;
  /**
   * The approval token the caller presented, handed to the handler only for a
   * capability that declares `forwardsApproval` (the request tool), which passes
   * it on to the action it asked for. Every other handler never sees a token.
   */
  approvalToken?: string;
  /**
   * The retry channel the surface asked for, handed on with
   * {@link approvalToken} and only to a `forwardsApproval` capability, so the
   * action it re-invokes tells the caller to retry the way it can.
   */
  retryChannel?: ApprovalRetryChannel;
  /**
   * Present when the caller proved it may decide approvals. A handler running its
   * own confirmation flow treats this exactly like {@link approval}: the person
   * whose consent that flow would go and fetch is the one already calling.
   */
  trusted?: TrustedCaller;
  /**
   * The invoking session, when the call arrived through a surface that has one
   * (the in-session `dorkos` server). Resumable flows may bind to this verified
   * session; it is absent on external `/mcp` and ordinary HTTP surfaces.
   */
  sessionId?: string;
  /**
   * That session's working directory, when the surface carries one — for a
   * handler that must record WHERE the caller is, not merely which session it
   * is. The managed-MCP sign-in stores it on its flow so a token that lands after
   * a restart still resumes the agent in the right place (DOR-981).
   */
  cwd?: string;
  /** Process-authenticated caller resolved by the server boundary. */
  /** See {@link CapabilityInvocationContext.mcpServer}. */
  mcpServer?: McpServerId;
  serverPrincipal?: ServerPrincipalProof;
  /** Abort only this capability call. */
  signal?: AbortSignal;
  /** Authenticated live authority established before approval and invocation. */
  preflight?: CapabilityPreflightResult;
  /** Verified program-selected agent; absent for runtime and public MCP callers. */
  connectorAgentId?: string;
  /** Server-known connector entry surface used only for immutable usage attribution. */
  connectorSurface?: 'mcp' | 'rest' | 'cli';
  /** The calling server's hand-registered tools; only the request tool receives it. */
  handTools?: HandToolReach;
  /**
   * True when the turn the call came from was started by somebody from off this
   * machine: a bridged Telegram or Slack sender, an external room author, an
   * outside agent, a connector event (`session/origin/outsider-turns.ts`). Read
   * off the invoking {@link sessionId}, so it is absent on surfaces with none.
   * A handler that would hand a stranger more than the turn's grant covers
   * refuses on it (PRINCIPLES §1).
   */
  turnStartedByOutsider?: boolean;
}

/**
 * Observer invoked after each capability invocation, for attribution and audit.
 *
 * Kept as an injected hook rather than a direct `ActivityService` dependency so
 * this module stays domain-free (see the module TSDoc on the dependency-free
 * spine). Boot wires it to the Activity feed; tests can assert on it directly.
 * It must never throw — {@link composeRegistry} does not guard the call site
 * beyond swallowing rejections, and an audit failure must not fail the call.
 */
export type CapabilityInvocationObserver = (event: {
  /** The capability that ran. */
  capability: CapabilityDefinition;
  /** The context the handler was invoked with. */
  context: CapabilityHandlerContext;
  /** Whether the handler completed without throwing. */
  ok: boolean;
  /**
   * What the handler threw, when it did. Lets the observer tell a refusal the
   * request tool passed on (a card raised, a request held back by its limits)
   * from a real failure.
   */
  error?: unknown;
}) => void;

/**
 * What {@link CapabilityRegistry.contribute} answers: a handle to take the
 * tools away again, or the reason nothing was added.
 */
export type ContributeResult =
  | {
      ok: true;
      /**
       * Take this contribution's tools away again. Idempotent: a second call,
       * or a call after the same owner contributed afresh, changes nothing.
       */
      remove(): void;
    }
  | { ok: false; reason: string };

export interface OriginalRoomMergeRegistryConstruction {
  readonly service: RoomMergeService;
  readonly nativePrincipals: ConnectorRuntimePrincipalService;
  readonly db: Db;
}
