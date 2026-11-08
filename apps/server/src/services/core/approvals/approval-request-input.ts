/**
 * What a caller hands {@link ApprovalService.request}, and the two records it
 * carries: where a verdict goes, and the connector authority frozen beside it.
 *
 * Moved out of `approval-service.ts` unchanged, so the service file holds the
 * approval lifecycle and stays under its line cap (Hard Rule 9).
 *
 * @module services/core/approvals/approval-request-input
 */
import type {
  ApprovalOrigin,
  ApprovalServiceAction,
  ApprovalSubject,
} from '@dorkos/shared/approval-schemas';
import type { PermissionAreaId } from '@dorkos/shared/permissions';
import type { MarketplaceCardInput } from './approval-storable.js';

/** What {@link ApprovalService.request} needs to describe a pending action. */
export interface ApprovalRequestInput {
  /** Capability the request would invoke, e.g. `marketplace.uninstall`. */
  capabilityId: string;
  /** Canonical hash of the invocation input (see `hashApprovalInput`). */
  inputHash: string;
  /** One plain sentence describing what the operator is about to allow. */
  summary: string;
  /** Full package disclosure, rebuilt and checked again before a yes. */
  packageRequest?: import('./approval-completeness.js').PackageApprovalRequest;
  /**
   * The card's title for this one request, in place of the capability's own
   * title. For a card whose question depends on what it is about, such as a
   * repo pin naming its worktree (DOR-3359). Honoured only for a capability
   * whose descriptor sets `titledPerRequest`; swept and capped like the summary.
   */
  title?: string;
  /**
   * The one argument a person has to read IN FULL before answering, verbatim.
   *
   * Supplied only for a capability that declares `approvalDetailField`. It is
   * NOT part of the summary and must not be duplicated into it: the summary is
   * a glanceable sentence with every value capped at 80 characters, which is the
   * bound this field exists to escape (DOR-1698).
   */
  detail?: string;
  /**
   * Opaque label for who asked — an agent path, a display name, whatever the
   * caller has. Never interpreted here, only shown on the card.
   */
  requestedBy?: string;
  /**
   * The stable agent path of whoever asked, when the caller identified itself.
   *
   * Recorded alongside `requestedBy` rather than instead of it, because the two
   * are different things: `requestedBy` is a display label built from a name and
   * swept for secrets, and a label is not a key. "Always allow" writes onto the
   * agent this path names and the blocked-request rate limits key on it, so the
   * card has to carry the real one. Never rendered.
   */
  requestedByPath?: string;
  /**
   * The permission area of the requested action, or absent/`null` for an action
   * with no area (spec `agent-permissions` D2). Decides, with the agent path,
   * whether the card may offer "Always allow".
   */
  area?: PermissionAreaId | null;
  /**
   * Set when the agent asked past a Blocked permission with `request_permission`
   * (spec `agent-permissions` D8): the reason it gave, which the card quotes.
   */
  blockedRequest?: { reason: string };
  /** Whether granting it could raise what agents may do (DOR-3037); see the column. */
  raisesPermissions?: boolean;
  /**
   * The thing this would act on, already named by its own registry (DOR-1929).
   *
   * Resolved before the request rather than here, because naming an id needs the
   * registry that owns it and this store owns none. Absent means it could not be
   * named, and the id is still in `summary` either way.
   */
  subject?: ApprovalSubject;
  /**
   * The arguments other than the subject, rendered — supplied only alongside a
   * `subject`, and only when any remain. See the wire schema's `otherArguments`.
   */
  otherArguments?: string;
  /**
   * What a connected-app action would do, in words (DOR-2504). Built by the
   * connector preflight from stored records; see the wire schema's
   * `serviceAction`.
   */
  serviceAction?: ApprovalServiceAction;
  /**
   * Which surface an UNATTRIBUTED request arrived over.
   *
   * Recorded only when `requestedBy` is absent: once the caller is named, where
   * it came from adds nothing a person needs. It is a display fact and never an
   * authorization one — nothing here or downstream reads it to decide anything.
   */
  origin?: ApprovalOrigin;
  /** Authenticated connector scope; absent for every ordinary capability. */
  connectorAuthority?: ApprovalConnectorAuthority;
  /**
   * The session this request came from, so a verdict decided after the
   * in-session hold gave up can still reach it (spec `approval-verdict-delivery`).
   *
   * Absent for every surface with no session — the external `/mcp` server, the
   * introspection stub — which is exactly the set with nowhere to deliver to.
   * It is a DELIVERY ADDRESS and never an authorization fact: nothing here or
   * downstream reads it to decide anything, for the same reason `origin` does
   * not.
   */
  requestingSession?: ApprovalRequestingSession;
  /**
   * A row under Needs you that nothing waits on (DOR-3427, `passive-approval.ts`):
   * it never expires and its notification never escalates. Only the harness
   * raises one, for a package Full held back.
   */
  passive?: boolean;
  /** A Marketplace card too long for `detail` (DOR-3070); see `storableMarketplaceCard`. */
  marketplace?: MarketplaceCardInput;
}

/** Where a verdict for one approval would be delivered, when there is anywhere. */
export interface ApprovalRequestingSession {
  /** The session that asked. */
  sessionId: string;
  /**
   * The directory that session runs in, when the surface knew one.
   *
   * Stored rather than looked up later because the lookup is what fails: the
   * projector registry empties on restart and an approval outlives one easily
   * inside two hours (the DOR-981 lesson `mcp-signin-resume` records as
   * `originCwd`).
   */
  cwd?: string;
}

/** Exact indexed connector authority frozen beside one approval. */
export interface ApprovalConnectorAuthority {
  /** Stable digest over owner, actor, runtime context, target, and parsed input. */
  readonly digest: string;
  /** Owner kind established by connector preflight. */
  readonly ownerKind: 'user' | 'local_install';
  /** Stable owner identifier established by connector preflight. */
  readonly ownerId: string;
  /** Stable agent whose exact operation grant applies. */
  readonly agentId?: string;
  /** Canonical session whose exact operation grant applies. */
  readonly sessionId?: string;
  /** Stable connection selected by the invocation. */
  readonly connectionId: string;
  /** Immutable operation revision selected by the invocation. */
  readonly operationRevisionId: string;
}
