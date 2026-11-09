/**
 * An agent answers another agent's request for Read on an app, and an agent
 * undoes an access change (spec `agent-grant-autonomy` §4.2, §4.3, phase 3).
 *
 * Approval gives Read only (W2), never to the approver itself and never from a
 * turn another agent started (W3), only on an app the approver holds at a
 * level, and never more than the approver holds there (W1). It writes the
 * requester's own grants only: no path here writes an every-agent row, and no
 * path lets an agent back into a share it was left out of.
 *
 * An agent's Undo is checked as what it does: putting access back is an
 * approval (N3), taking it away is a narrowing (§4.1), and lifting an
 * exclusion is a person's. Every refusal is a ledger row and an audit row.
 *
 * The limits are the ones DorkOS can prove today (§4.4): marked turns and
 * agent-started turns. A turn that reads an email or web page through an app
 * isn't marked yet, so nothing here may claim to catch that.
 *
 * @module services/connectors/access/access-approval
 */
import { ulid } from 'ulidx';
import {
  and,
  connectionGrantChanges,
  connections,
  connectorOperationRevisions,
  connectorProviderInstances,
  eq,
  inArray,
  isNull,
  type Db,
  type DbTransaction,
  type GrantChangeKind,
} from '@dorkos/db';
import { describeAccessChange, type AccessChangeEvents } from './access-change-events.js';
import {
  NARROWING_MESSAGES,
  NARROW_OTHERS_PER_HOUR,
  otherNarrowingsInLastHour,
  validReason,
  type NarrowCaller,
} from './access-narrowing.js';
import { isNarrowing, readAccessState, sameState, type AccessState } from './access-state.js';
import {
  findBinding,
  ownerColumns,
  writeAccessState,
  type AccessBinding,
  type AccessManagedAuthority,
} from './access-writes.js';
import { approverHolding } from './approver-holding.js';
import { anotherAgentTurnRefusal, type TurnGateRefusal } from './turn-gate.js';
import type { ConnectorOwnerAuthority } from '../principal/server-principal.js';

/** Every refusal approval or an agent's Undo can give, with its words (§7). */
export const APPROVAL_MESSAGES = {
  ...NARROWING_MESSAGES,
  APPROVE_SELF: "You can't approve your own request. A person or another agent has to.",
  APPROVE_NOT_READ: 'Agents can approve read access only. A person approves write access.',
  APPROVE_EXCLUDED: 'A person left this agent out of this app. Only a person can let it back in.',
  APPROVE_NOT_HELD: 'You can only approve access to an app you can use yourself.',
  APPROVE_ABOVE_OWN: 'You can only approve access you hold yourself, at or below your own.',
  APPROVE_CHOOSE_APP:
    'You can use more than one account for that service. Say which one with connectionId.',
  APPROVE_NOT_FOUND: 'No request like that is waiting here.',
  EXCLUSION_PERSON_ONLY: 'Only a person can let an agent back into a share.',
} as const;

/** A refusal code. */
export type ApprovalRefusal = keyof typeof APPROVAL_MESSAGES;

/** A typed refusal; its message is safe to hand the caller. */
export class AccessApprovalError extends Error {
  /**
   * Refuse with one code; the message is the words that code gives the caller.
   *
   * @param code - The refusal.
   */
  constructor(readonly code: ApprovalRefusal) {
    super(APPROVAL_MESSAGES[code]);
    this.name = 'AccessApprovalError';
  }
}

/** One request still waiting on an answer, as approval needs it. */
export interface PendingAgentRequest {
  /** The agent that asked. */
  readonly agentId: string;
  /** The service it asked for (an app's toolkit). */
  readonly serviceSlug: string;
  /** The level it asked for. */
  readonly requestedAccess: 'read' | 'read-write';
}

/** The agent requests approval reads and answers. */
export interface ApprovalRequests {
  /** The owner's request, while it still waits; otherwise `null`. */
  pending(owner: ConnectorOwnerAuthority, requestId: string): PendingAgentRequest | null;
  /** Answer it with the access the requester now holds on that app. */
  resolveWithCurrentAccess(
    owner: ConnectorOwnerAuthority,
    requestId: string,
    connectionId: string
  ): Promise<void>;
}

/** What an approval did. */
export interface ApprovalResult {
  /** The ledger row, for Undo; `null` when the requester already held it. */
  readonly changeId: string | null;
  readonly connectionId: string;
  /** Whether the request was answered; `false` leaves it waiting for a person. */
  readonly requestAnswered: boolean;
}

/** Construction options. */
export interface AccessApprovalServiceOptions {
  readonly db: Db;
  readonly requests: ApprovalRequests;
  readonly events: AccessChangeEvents;
  readonly managedAuthority?: AccessManagedAuthority;
  /** The turn gate; the live one by default. Injected for tests. */
  readonly turnGate?: (caller: NarrowCaller) => TurnGateRefusal | null;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

/** Approves read requests for agents, and runs an agent's Undo. */
export class AccessApprovalService {
  private readonly db: Db;
  private readonly options: AccessApprovalServiceOptions;
  private readonly now: () => Date;
  private readonly createId: () => string;

  /** Construct over canonical connector state. */
  constructor(options: AccessApprovalServiceOptions) {
    this.db = options.db;
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? ulid;
  }

  /**
   * Give another agent the Read it asked for, from what the caller holds.
   *
   * @param caller - The approving agent.
   * @param input - The request, and which app when the caller holds several.
   */
  async approve(
    caller: NarrowCaller,
    input: { readonly requestId: string; readonly connectionId?: string }
  ): Promise<ApprovalResult> {
    const request = this.options.requests.pending(caller.owner, input.requestId);
    if (!request) throw new AccessApprovalError('APPROVE_NOT_FOUND');
    const row = {
      targetAgentId: request.agentId,
      // Refused before an app is chosen: the row names the service asked for.
      connectionId: input.connectionId ?? `service:${request.serviceSlug}`,
      requestId: input.requestId,
    };
    if (request.agentId === caller.agentId) this.refuse(caller, row, 'APPROVE_SELF');
    if (request.requestedAccess !== 'read') this.refuse(caller, row, 'APPROVE_NOT_READ');
    const gate = (this.options.turnGate ?? anotherAgentTurnRefusal)(caller);
    if (gate) this.refuse(caller, row, gate);
    const connectionId = this.pickApp(caller, request, input.connectionId, row);
    const at = { ...row, connectionId };
    const now = this.now().toISOString();
    const outcome = this.db.transaction((tx) => {
      // Read again inside the write: a request answered or withdrawn since, or
      // one another approval already answered, is never approved twice.
      if (
        !this.options.requests.pending(caller.owner, input.requestId) ||
        this.alreadyApproved(tx, input.requestId)
      ) {
        return { refusal: 'APPROVE_NOT_FOUND' as const };
      }
      const binding = this.requireBinding(tx, caller.owner, connectionId);
      const before = readAccessState(tx, request.agentId, connectionId);
      if (before.excluded) return { refusal: 'APPROVE_EXCLUDED' as const };
      const held = approverHolding(tx, caller, connectionId);
      if (held.readIds.length === 0) return { refusal: 'APPROVE_NOT_HELD' as const };
      if (held.level === null) return { refusal: 'APPROVE_ABOVE_OWN' as const };
      const after: AccessState = {
        level: before.level ?? (before.revisionIds.length === 0 ? 'read' : null),
        revisionIds: [...new Set([...before.revisionIds, ...held.readIds])].sort(),
        excluded: false,
      };
      if (sameState(before, after)) return { binding, before, after, changeId: null };
      const commandId = this.write(tx, binding, caller, request.agentId, before, after, now);
      const changeId = this.createId();
      this.insertApplied(tx, caller, {
        id: changeId,
        kind: 'approve_read',
        targetAgentId: request.agentId,
        connectionId,
        before,
        after,
        requestId: input.requestId,
        now,
      });
      return { binding, before, after, changeId, commandId };
    });
    if ('refusal' in outcome && outcome.refusal) this.refuse(caller, at, outcome.refusal);
    if (outcome.changeId !== null) {
      await this.deliver(outcome.commandId);
      this.options.events.changed(
        describeAccessChange({
          changeId: outcome.changeId,
          kind: 'approve_read',
          actorAgentId: caller.agentId,
          targetAgentId: request.agentId,
          app: outcome.binding,
          before: outcome.before,
          after: outcome.after,
        })
      );
    }
    let requestAnswered = true;
    try {
      await this.options.requests.resolveWithCurrentAccess(
        caller.owner,
        input.requestId,
        connectionId
      );
    } catch {
      // The access is given and recorded; the request stays for a person.
      requestAnswered = false;
    }
    return { changeId: outcome.changeId, connectionId, requestAnswered };
  }

  /**
   * An agent undoes one access change, checked as what the Undo does.
   *
   * @param caller - The agent undoing it.
   * @param input - The change, and a reason when it takes another agent's access.
   */
  async undo(
    caller: NarrowCaller,
    input: { readonly changeId: string; readonly reason?: string }
  ): Promise<{ undoId: string }> {
    const plan = this.db.transaction((tx) => {
      const change = tx
        .select()
        .from(connectionGrantChanges)
        .where(eq(connectionGrantChanges.id, input.changeId))
        .get();
      if (!change || change.outcome !== 'applied' || change.undoneBy) return null;
      if (!findBinding(tx, caller.owner, change.connectionId)) return null;
      const before = JSON.parse(change.beforeJson!) as AccessState;
      const after = JSON.parse(change.afterJson!) as AccessState;
      return {
        change,
        before,
        after,
        current: readAccessState(tx, change.targetAgentId, change.connectionId),
      };
    });
    if (!plan) throw new AccessApprovalError('UNDO_NOT_FOUND');
    const target = plan.change.targetAgentId;
    const row = {
      targetAgentId: target,
      connectionId: plan.change.connectionId,
      undoOf: plan.change.id,
    };
    if (plan.after.excluded && !plan.before.excluded) {
      this.refuse(caller, row, 'EXCLUSION_PERSON_ONLY');
    }
    if (!sameState(plan.current, plan.after)) throw new AccessApprovalError('UNDO_STALE');
    const takesAway = isNarrowing(plan.current, plan.before);
    const own = target === caller.agentId;
    const reason = validReason(input.reason);
    if (takesAway && !own) {
      // Taking another agent's access away: the narrowing rules (§4.1).
      if (reason === null) throw new AccessApprovalError('GRANT_REASON_REQUIRED');
      const gate = (this.options.turnGate ?? anotherAgentTurnRefusal)(caller);
      if (gate) this.refuse(caller, row, gate);
      if (
        otherNarrowingsInLastHour(this.db, caller.agentId, this.now()) >= NARROW_OTHERS_PER_HOUR
      ) {
        this.refuse(caller, row, 'GRANT_NARROW_RATE');
      }
    } else if (!takesAway) {
      // Putting access back: the approval rules (§4.2, N3).
      if (own) this.refuse(caller, row, 'APPROVE_SELF');
      const gate = (this.options.turnGate ?? anotherAgentTurnRefusal)(caller);
      if (gate) this.refuse(caller, row, gate);
      const refusal = this.db.transaction((tx) =>
        this.widenRefusal(tx, caller, plan.change.connectionId, plan.current, plan.before)
      );
      if (refusal) this.refuse(caller, row, refusal);
    }
    const now = this.now().toISOString();
    const done = this.db.transaction((tx) => {
      const binding = this.requireBinding(tx, caller.owner, plan.change.connectionId);
      const current = readAccessState(tx, target, plan.change.connectionId);
      if (!sameState(current, plan.after)) throw new AccessApprovalError('UNDO_STALE');
      const commandId = this.write(tx, binding, caller, target, current, plan.before, now);
      const undoId = this.createId();
      this.insertApplied(tx, caller, {
        id: undoId,
        kind: 'undo',
        targetAgentId: target,
        connectionId: plan.change.connectionId,
        before: current,
        after: plan.before,
        undoOf: plan.change.id,
        reason: takesAway && !own ? reason : null,
        now,
      });
      tx.update(connectionGrantChanges)
        .set({ undoneBy: undoId })
        .where(eq(connectionGrantChanges.id, plan.change.id))
        .run();
      return { undoId, commandId, binding };
    });
    await this.deliver(done.commandId);
    this.options.events.undone({
      changeId: plan.change.id,
      undoId: done.undoId,
      actorAgentId: plan.change.actorId,
      targetAgentId: target,
      app: done.binding,
      by: { agentId: caller.agentId },
      needsYou: takesAway && !own,
    });
    return { undoId: done.undoId };
  }

  /** Why putting `restore` back over `current` is more than the caller may give, if it is. */
  private widenRefusal(
    tx: DbTransaction,
    caller: NarrowCaller,
    connectionId: string,
    current: AccessState,
    restore: AccessState
  ): ApprovalRefusal | null {
    if (restore.level === 'read-write' && current.level !== 'read-write') return 'APPROVE_NOT_READ';
    const held = new Set(current.revisionIds);
    const added = restore.revisionIds.filter((id) => !held.has(id));
    if (added.length > 0) {
      const reads = new Set(
        tx
          .select({ id: connectorOperationRevisions.id })
          .from(connectorOperationRevisions)
          .where(
            and(
              inArray(connectorOperationRevisions.id, added),
              eq(connectorOperationRevisions.capabilityClassification, 'read')
            )
          )
          .all()
          .map((r) => r.id)
      );
      if (added.some((id) => !reads.has(id))) return 'APPROVE_NOT_READ';
    }
    if (current.excluded) return 'APPROVE_EXCLUDED';
    const mine = approverHolding(tx, caller, connectionId);
    if (mine.readIds.length === 0) return 'APPROVE_NOT_HELD';
    const ownReads = new Set(mine.readIds);
    if (!added.every((id) => ownReads.has(id))) return 'APPROVE_ABOVE_OWN';
    if (restore.level !== null && restore.level !== current.level && mine.level === null) {
      return 'APPROVE_ABOVE_OWN';
    }
    return null;
  }

  /** The app to give Read on: the one named, or the only one the caller holds for that service. */
  private pickApp(
    caller: NarrowCaller,
    request: PendingAgentRequest,
    named: string | undefined,
    row: { targetAgentId: string; connectionId: string; requestId: string }
  ): string {
    const expected = ownerColumns(caller.owner);
    const ids = this.db
      .select({ id: connections.id })
      .from(connections)
      .innerJoin(
        connectorProviderInstances,
        eq(connectorProviderInstances.id, connections.providerInstanceId)
      )
      .where(
        and(
          eq(connections.toolkit, request.serviceSlug),
          isNull(connections.removedAt),
          eq(connectorProviderInstances.ownerKind, expected.ownerKind),
          eq(connectorProviderInstances.ownerId, expected.ownerId)
        )
      )
      .all()
      .map((r) => r.id);
    if (named !== undefined) {
      if (!ids.includes(named)) this.refuse(caller, row, 'GRANT_NOT_FOUND');
      return named;
    }
    const held = this.db.transaction((tx) =>
      ids.filter((id) => approverHolding(tx, caller, id).readIds.length > 0)
    );
    if (held.length === 0) this.refuse(caller, row, 'APPROVE_NOT_HELD');
    if (held.length > 1) this.refuse(caller, row, 'APPROVE_CHOOSE_APP');
    return held[0]!;
  }

  /** Whether an agent's approval already answered this request. */
  private alreadyApproved(tx: DbTransaction, requestId: string): boolean {
    return (
      tx
        .select({ id: connectionGrantChanges.id })
        .from(connectionGrantChanges)
        .where(
          and(
            eq(connectionGrantChanges.requestId, requestId),
            eq(connectionGrantChanges.kind, 'approve_read'),
            eq(connectionGrantChanges.outcome, 'applied')
          )
        )
        .get() !== undefined
    );
  }

  private write(
    tx: DbTransaction,
    binding: AccessBinding,
    caller: NarrowCaller,
    agentId: string,
    before: AccessState,
    after: AccessState,
    now: string
  ): string | undefined {
    return writeAccessState(tx, {
      binding,
      owner: caller.owner,
      agentId,
      before,
      after,
      author: `agent:${caller.agentId}`,
      now,
      managedAuthority: this.options.managedAuthority,
      createId: this.createId,
      onManagedUnavailable: () => {
        throw new AccessApprovalError('GRANT_MANAGED_UNAVAILABLE');
      },
    });
  }

  private async deliver(commandId: string | undefined): Promise<void> {
    if (!commandId) return;
    await this.options.managedAuthority!.deliverAgentGrantReplacement(
      commandId,
      AbortSignal.timeout(10_000)
    );
  }

  private requireBinding(
    tx: DbTransaction,
    owner: ConnectorOwnerAuthority,
    connectionId: string
  ): AccessBinding {
    const binding = findBinding(tx, owner, connectionId);
    if (!binding) throw new AccessApprovalError('GRANT_NOT_FOUND');
    return binding;
  }

  private insertApplied(
    tx: DbTransaction,
    caller: NarrowCaller,
    input: {
      id: string;
      kind: GrantChangeKind;
      targetAgentId: string;
      connectionId: string;
      before: AccessState;
      after: AccessState;
      requestId?: string;
      undoOf?: string;
      reason?: string | null;
      now: string;
    }
  ): void {
    tx.insert(connectionGrantChanges)
      .values({
        id: input.id,
        kind: input.kind,
        outcome: 'applied',
        actorKind: 'agent',
        actorId: caller.agentId,
        actorSessionId: caller.sessionId ?? null,
        targetAgentId: input.targetAgentId,
        connectionId: input.connectionId,
        beforeJson: JSON.stringify(input.before),
        afterJson: JSON.stringify(input.after),
        reason: input.reason ?? null,
        requestId: input.requestId ?? null,
        undoOf: input.undoOf ?? null,
        createdAt: input.now,
      })
      .run();
  }

  /** Record a refusal in the ledger and the audit trail, then throw it. */
  private refuse(
    caller: NarrowCaller,
    row: { targetAgentId: string; connectionId: string; requestId?: string; undoOf?: string },
    code: ApprovalRefusal
  ): never {
    this.db
      .insert(connectionGrantChanges)
      .values({
        id: this.createId(),
        kind: row.undoOf ? 'undo' : 'approve_read',
        outcome: 'refused',
        refusalCode: code,
        actorKind: 'agent',
        actorId: caller.agentId,
        actorSessionId: caller.sessionId ?? null,
        targetAgentId: row.targetAgentId,
        connectionId: row.connectionId,
        requestId: row.requestId ?? null,
        undoOf: row.undoOf ?? null,
        createdAt: this.now().toISOString(),
      })
      .run();
    this.options.events.refused({
      code,
      actorAgentId: caller.agentId,
      targetAgentId: row.targetAgentId,
      connectionId: row.connectionId,
      kind: row.undoOf ? 'undo' : 'approve_read',
    });
    throw new AccessApprovalError(code);
  }
}
