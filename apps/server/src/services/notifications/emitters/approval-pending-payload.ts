/**
 * What an `approval.pending` notice carries (spec `agent-trust`): an agent
 * asked to do something irreversible, or to spend money, and waits on a yes.
 * Kept beside its emitter so the registry stays a table of entries.
 *
 * @module services/notifications/emitters/approval-pending-payload
 */

/**
 * The `approvals` table's own pending row is the state; this describes it to
 * the operator. Deliberately carries NO argument values — the approval card
 * shows those, and this payload is what a phone push, a desktop banner and a
 * chat app's message are built from.
 */
export interface ApprovalPendingPayload {
  /** ULID of the pending approval. */
  approvalId: string;
  /** The capability or tool that would run, e.g. `tasks_delete`. */
  capabilityId: string;
  /**
   * Its human-facing title, from the capability registry — never from the
   * requester (`approval-service.ts`'s `CapabilityDescriptorLookup`). For a
   * connected-app action it is the action and app instead ("Delete message
   * in Gmail", `approvalHeading`), which the server read from its own
   * records; still no argument values.
   */
  capabilityTitle: string;
  /**
   * The Mesh agent that asked, when its project path resolves to one. The
   * lens key, and what routes the escalation's chat leg.
   */
  agentId?: string;
  /** What to call whoever asked. */
  requestedBy: string;
  /**
   * A row under Needs you that nothing waits on (DOR-3427): `notable`, so it
   * never escalates, with words that say so.
   */
  passive?: true;
  /**
   * A paid run's card (DOR-4204 spec 1.1): only a person answers it, in
   * DorkOS, so a chat app or a lock screen says where, never offers a yes.
   */
  spend?: true;
}
