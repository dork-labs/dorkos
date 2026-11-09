/**
 * An agent takes connection access away: its own, or another agent's (spec
 * `agent-grant-autonomy` §4.1, phase 2). A person undoes it in one tap.
 *
 * Narrowing never adds a grant, never touches the connection or the account,
 * and never writes an every-agent row. Taking an agent out of an every-agent
 * share writes an exclusion; only a person lifts one.
 *
 * Narrowing another agent also needs: a one-line reason (designer), a turn the
 * gate allows (N1, E2), and fewer than three such changes by the caller in the
 * last hour (Security G1). It raises a Needs-you item with Undo (G2). The
 * reason is kept on the ledger row and read back only by the person's routes:
 * never put into Activity, a notification, or anything an agent reads.
 *
 * An exclusion is policy, not containment: an excluded agent can still ask
 * another agent to use the app for it. Nothing here may promise more than
 * "this agent can't use it directly".
 *
 * @module services/connectors/access/access-narrowing
 */
import { ulid } from 'ulidx';
import {
  and,
  connectionGrantChanges,
  connectorOperationRevisions,
  count,
  eq,
  gt,
  inArray,
  ne,
  or,
  type Db,
  type DbTransaction,
  type GrantChangeKind,
} from '@dorkos/db';
import type { ConnectorOwnerAuthority } from '../principal/server-principal.js';
import {
  anotherAgentTurnRefusal,
  noteMarkedTurnRefusal,
  TURN_GATE_MESSAGES,
  type TurnGateRefusal,
} from './turn-gate.js';

/** The tool a marked turn's refused narrowing names on its Activity line. */
const NARROW_AGENT_ACTION = {
  id: 'connectors.narrow_agent_access',
  title: "Take away another agent's access to a connected app",
} as const;
import { describeAccessChange, type AccessChangeEvents } from './access-change-events.js';
import { isNarrowing, sameState, readAccessState, type AccessState } from './access-state.js';
import {
  findBinding,
  ownerColumns,
  writeAccessState,
  type AccessBinding,
  type AccessManagedAuthority,
} from './access-writes.js';

export { isNarrowing, readAccessState, type AccessState } from './access-state.js';

/** At most this many narrowings of OTHER agents per caller per hour (G1). */
export const NARROW_OTHERS_PER_HOUR = 3;

/** The longest reason, in words. */
export const REASON_MAX_WORDS = 15;

/** Every refusal an agent can get here, with the words it gets (§7). */
export const NARROWING_MESSAGES = {
  ...TURN_GATE_MESSAGES,
  GRANT_REASON_REQUIRED: 'Say why in one line, 15 words at most. The person sees it.',
  GRANT_NARROW_RATE: `You've lowered other agents' access ${NARROW_OTHERS_PER_HOUR} times this hour. Ask a person for more.`,
  GRANT_NOT_A_NARROWING: 'That would add access. Ask for it with request_connection instead.',
  GRANT_NOTHING_TO_NARROW:
    'That agent has no access of its own on this app. To stop the every-agent share reaching it, use leaveOutOfShare.',
  GRANT_NOT_FOUND: 'No such app or agent here.',
  GRANT_MANAGED_UNAVAILABLE:
    "This app connects through a DorkOS account that isn't linked right now. Ask a person.",
  UNDO_STALE: 'Access has changed since then. Set it on the Connections page instead.',
  UNDO_NOT_FOUND: 'Nothing to undo there.',
} as const;

/** A refusal code. */
export type NarrowingRefusal = keyof typeof NARROWING_MESSAGES;

/** A typed refusal; its message is safe to hand the caller. */
export class AccessNarrowingError extends Error {
  /**
   * Refuse with one code; the message is the words that code gives the caller.
   *
   * @param code - The refusal.
   */
  constructor(readonly code: NarrowingRefusal) {
    super(NARROWING_MESSAGES[code]);
    this.name = 'AccessNarrowingError';
  }
}

/** What to take away. */
export type NarrowChange =
  | { readonly kind: 'level'; readonly to: 'read' | 'none' }
  | { readonly kind: 'remove'; readonly operationRevisionIds: readonly string[] }
  | { readonly kind: 'leave_out' };

/** The calling agent, from its verified principal. */
export interface NarrowCaller {
  readonly agentId: string;
  readonly agentPath?: string;
  readonly sessionId?: string;
  readonly owner: ConnectorOwnerAuthority;
}

/** What one narrowing did. */
export interface NarrowResult {
  /** The ledger row, for Undo; `null` when nothing changed. */
  readonly changeId: string | null;
  readonly changed: boolean;
  readonly before: AccessState;
  readonly after: AccessState;
}

/** Construction options. */
export interface AccessNarrowingServiceOptions {
  readonly db: Db;
  /** Whether the owner has this agent. */
  readonly ownsAgent: (owner: ConnectorOwnerAuthority, agentId: string) => boolean;
  /** Hosted authority, for apps connected through a DorkOS account. */
  readonly managedAuthority?: AccessManagedAuthority;
  /** Activity, audit and Needs-you. */
  readonly events: AccessChangeEvents;
  /** The turn gate; the live one by default. Injected for tests. */
  readonly turnGate?: (caller: NarrowCaller) => TurnGateRefusal | null;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

/**
 * Check a reason: one line, at least one word, at most {@link REASON_MAX_WORDS}.
 *
 * @param reason - What the agent wrote.
 * @returns The trimmed reason, or `null` when it does not pass.
 */
export function validReason(reason: string | undefined): string | null {
  if (reason === undefined) return null;
  if (/[\r\n\u2028\u2029]/.test(reason)) return null;
  const trimmed = reason.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > REASON_MAX_WORDS || trimmed.length > 200) return null;
  return trimmed;
}

/** Takes access away for agents, and puts it back for a person. */
export class AccessNarrowingService {
  private readonly db: Db;
  private readonly options: AccessNarrowingServiceOptions;
  private readonly now: () => Date;
  private readonly createId: () => string;

  /** Construct over canonical connector state. */
  constructor(options: AccessNarrowingServiceOptions) {
    this.db = options.db;
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? ulid;
  }

  /**
   * Take access away from an agent: the caller itself, or another agent.
   *
   * @param caller - The calling agent.
   * @param input - Whose access, on which app, what to take, and why.
   */
  async narrow(
    caller: NarrowCaller,
    input: {
      readonly targetAgentId: string;
      readonly connectionId: string;
      readonly change: NarrowChange;
      readonly reason?: string;
    }
  ): Promise<NarrowResult> {
    const other = input.targetAgentId !== caller.agentId;
    const reason = validReason(input.reason);
    if ((other || input.reason !== undefined) && reason === null) {
      throw new AccessNarrowingError('GRANT_REASON_REQUIRED');
    }
    const kind: GrantChangeKind =
      input.change.kind === 'leave_out'
        ? other
          ? 'exclude_other'
          : 'exclude_own'
        : other
          ? 'narrow_other'
          : 'narrow_own';
    if (other) {
      const gate = (this.options.turnGate ?? anotherAgentTurnRefusal)(caller);
      if (gate === 'GRANT_MARKED_TURN') noteMarkedTurnRefusal(caller, NARROW_AGENT_ACTION);
      if (gate) this.refuse(caller, input, kind, gate);
      if (this.recentOtherNarrowings(caller.agentId) >= NARROW_OTHERS_PER_HOUR) {
        this.refuse(caller, input, kind, 'GRANT_NARROW_RATE');
      }
    }
    if (!this.options.ownsAgent(caller.owner, input.targetAgentId)) {
      throw new AccessNarrowingError('GRANT_NOT_FOUND');
    }
    const now = this.now().toISOString();
    const outcome = this.db.transaction((tx) => {
      const binding = this.requireBinding(tx, caller.owner, input.connectionId);
      const before = readAccessState(tx, input.targetAgentId, input.connectionId);
      const after = this.afterFor(tx, before, input.change);
      if (sameState(before, after)) return { binding, before, after, changeId: null };
      if (!isNarrowing(before, after)) throw new AccessNarrowingError('GRANT_NOT_A_NARROWING');
      const commandId = this.writeState(tx, {
        binding,
        owner: caller.owner,
        agentId: input.targetAgentId,
        before,
        after,
        author: `agent:${caller.agentId}`,
        now,
      });
      const changeId = this.createId();
      tx.insert(connectionGrantChanges)
        .values({
          id: changeId,
          kind,
          outcome: 'applied',
          actorKind: 'agent',
          actorId: caller.agentId,
          actorSessionId: caller.sessionId ?? null,
          targetAgentId: input.targetAgentId,
          connectionId: input.connectionId,
          beforeJson: JSON.stringify(before),
          afterJson: JSON.stringify(after),
          reason,
          createdAt: now,
        })
        .run();
      return { binding, before, after, changeId, commandId };
    });
    if (outcome.changeId === null) {
      return { changeId: null, changed: false, before: outcome.before, after: outcome.after };
    }
    if ('commandId' in outcome && outcome.commandId) {
      await this.options.managedAuthority!.deliverAgentGrantReplacement(
        outcome.commandId,
        AbortSignal.timeout(10_000)
      );
    }
    this.options.events.changed(
      describeAccessChange({
        changeId: outcome.changeId,
        kind,
        actorAgentId: caller.agentId,
        targetAgentId: input.targetAgentId,
        app: outcome.binding,
        before: outcome.before,
        after: outcome.after,
      })
    );
    return {
      changeId: outcome.changeId,
      changed: true,
      before: outcome.before,
      after: outcome.after,
    };
  }

  /**
   * A person puts back what an agent's change took away. Refused when access
   * changed since, so it never overwrites a later choice.
   *
   * @param owner - The verified owner.
   * @param changeId - The ledger row to undo.
   */
  async undo(owner: ConnectorOwnerAuthority, changeId: string): Promise<{ undoId: string }> {
    const now = this.now().toISOString();
    const result = this.db.transaction((tx) => {
      const row = tx
        .select()
        .from(connectionGrantChanges)
        .where(eq(connectionGrantChanges.id, changeId))
        .get();
      // A person's own Undo is final here; an agent's Undo a person can put back.
      const personsUndo = row?.kind === 'undo' && row.actorKind === 'person';
      if (!row || row.outcome !== 'applied' || personsUndo || row.undoneBy) {
        throw new AccessNarrowingError('UNDO_NOT_FOUND');
      }
      const binding = this.requireBinding(tx, owner, row.connectionId);
      const before = JSON.parse(row.beforeJson!) as AccessState;
      const after = JSON.parse(row.afterJson!) as AccessState;
      const current = readAccessState(tx, row.targetAgentId, row.connectionId);
      if (!sameState(current, after)) throw new AccessNarrowingError('UNDO_STALE');
      const ownerId = ownerColumns(owner).ownerId;
      const commandId = this.writeState(tx, {
        binding,
        owner,
        agentId: row.targetAgentId,
        before: current,
        after: before,
        author: ownerId,
        now,
      });
      const undoId = this.createId();
      tx.insert(connectionGrantChanges)
        .values({
          id: undoId,
          kind: 'undo',
          outcome: 'applied',
          actorKind: 'person',
          actorId: ownerId,
          targetAgentId: row.targetAgentId,
          connectionId: row.connectionId,
          beforeJson: JSON.stringify(current),
          afterJson: JSON.stringify(before),
          undoOf: row.id,
          createdAt: now,
        })
        .run();
      tx.update(connectionGrantChanges)
        .set({ undoneBy: undoId })
        .where(eq(connectionGrantChanges.id, row.id))
        .run();
      return { undoId, commandId, binding, row, current, before };
    });
    if (result.commandId) {
      await this.options.managedAuthority!.deliverAgentGrantReplacement(
        result.commandId,
        AbortSignal.timeout(10_000)
      );
    }
    this.options.events.undone({
      changeId: result.row.id,
      undoId: result.undoId,
      actorAgentId: result.row.actorId,
      targetAgentId: result.row.targetAgentId,
      app: result.binding,
    });
    return { undoId: result.undoId };
  }

  /** How many other-agent narrowings the caller made in the last hour. */
  private recentOtherNarrowings(agentId: string): number {
    return otherNarrowingsInLastHour(this.db, agentId, this.now());
  }

  /** Record a refusal in the ledger and the audit trail, then throw it. */
  private refuse(
    caller: NarrowCaller,
    input: {
      readonly targetAgentId: string;
      readonly connectionId: string;
      readonly reason?: string;
    },
    kind: GrantChangeKind,
    code: NarrowingRefusal
  ): never {
    this.db
      .insert(connectionGrantChanges)
      .values({
        id: this.createId(),
        kind,
        outcome: 'refused',
        refusalCode: code,
        actorKind: 'agent',
        actorId: caller.agentId,
        actorSessionId: caller.sessionId ?? null,
        targetAgentId: input.targetAgentId,
        connectionId: input.connectionId,
        reason: validReason(input.reason),
        createdAt: this.now().toISOString(),
      })
      .run();
    this.options.events.refused({
      code,
      actorAgentId: caller.agentId,
      targetAgentId: input.targetAgentId,
      connectionId: input.connectionId,
    });
    throw new AccessNarrowingError(code);
  }

  private afterFor(tx: DbTransaction, before: AccessState, change: NarrowChange): AccessState {
    if (change.kind === 'leave_out') return { ...before, excluded: true };
    if (before.revisionIds.length === 0 && before.level === null) {
      throw new AccessNarrowingError('GRANT_NOTHING_TO_NARROW');
    }
    if (change.kind === 'remove') {
      const drop = new Set(change.operationRevisionIds);
      const kept = before.revisionIds.filter((id) => !drop.has(id));
      return kept.length === before.revisionIds.length
        ? before
        : { ...before, level: null, revisionIds: kept };
    }
    if (change.to === 'none') return { ...before, level: null, revisionIds: [] };
    const reads = new Set(
      before.revisionIds.length === 0
        ? []
        : tx
            .select({ id: connectorOperationRevisions.id })
            .from(connectorOperationRevisions)
            .where(
              and(
                inArray(connectorOperationRevisions.id, [...before.revisionIds]),
                eq(connectorOperationRevisions.capabilityClassification, 'read')
              )
            )
            .all()
            .map((row) => row.id)
    );
    return {
      ...before,
      level: before.level === null ? null : 'read',
      revisionIds: before.revisionIds.filter((id) => reads.has(id)),
    };
  }

  /** Write one agent's access from `before` to `after`; returns a hosted command to deliver, if any. */
  private writeState(
    tx: DbTransaction,
    input: {
      binding: AccessBinding;
      owner: ConnectorOwnerAuthority;
      agentId: string;
      before: AccessState;
      after: AccessState;
      author: string;
      now: string;
    }
  ): string | undefined {
    return writeAccessState(tx, {
      ...input,
      managedAuthority: this.options.managedAuthority,
      createId: this.createId,
      onManagedUnavailable: () => {
        throw new AccessNarrowingError('GRANT_MANAGED_UNAVAILABLE');
      },
    });
  }

  private requireBinding(
    tx: DbTransaction,
    owner: ConnectorOwnerAuthority,
    connectionId: string
  ): AccessBinding {
    const binding = findBinding(tx, owner, connectionId);
    if (!binding) throw new AccessNarrowingError('GRANT_NOT_FOUND');
    return binding;
  }
}

/**
 * How many times one agent took access from OTHER agents in the hour before
 * `now` (G1): its narrowings and exclusions of other agents, and every Undo it
 * made of another agent's access. An Undo is counted whichever way it went, so
 * the budget errs toward fewer changes. A count that can't be read reads as the
 * limit, so the next one is refused.
 *
 * @param db - The database.
 * @param agentId - The calling agent.
 * @param now - The clock.
 */
export function otherNarrowingsInLastHour(db: Db, agentId: string, now: Date): number {
  const since = new Date(now.getTime() - 60 * 60_000).toISOString();
  const row = db
    .select({ n: count() })
    .from(connectionGrantChanges)
    .where(
      and(
        eq(connectionGrantChanges.actorId, agentId),
        eq(connectionGrantChanges.actorKind, 'agent'),
        eq(connectionGrantChanges.outcome, 'applied'),
        or(
          inArray(connectionGrantChanges.kind, ['narrow_other', 'exclude_other']),
          and(
            eq(connectionGrantChanges.kind, 'undo'),
            ne(connectionGrantChanges.targetAgentId, agentId)
          )
        ),
        gt(connectionGrantChanges.createdAt, since)
      )
    )
    .get();
  return row?.n ?? NARROW_OTHERS_PER_HOUR;
}
