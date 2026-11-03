/**
 * To-dos (DOR-3088): one thing someone has to do, assigned to one agent or one person, on the same
 * record as an agent's promises. This service makes and changes them; it starts no turns (that is
 * the turns layer, which reads what this one stores).
 *
 * The rules it keeps, whichever surface a change arrives through:
 *
 * - **The server sets who and how strong** (Must 6). `assigned_by`, the chain, and the authority
 *   come from the {@link TodoActor} the server established, never from the caller's input.
 * - **The creating turn's power is stored** (Must 1): an agent's to-do carries that turn's level
 *   and marks; a person's carries `person` only with proof (`personProof`).
 * - **Authority belongs to the last actor too** (Must 3): every change to the assignee, state,
 *   title or notes lowers the stored authority to the lower of the row's and the actor's, and adds
 *   the actor's marks.
 * - **Agents change only their own** (Must 6, a build gate): an agent changes the state only of
 *   to-dos assigned to it, and reassigns only to-dos it made (`todo-policy.ts`).
 * - **No loops** (Must 5, in part): an agent-made to-do is one deeper than the to-do whose turn
 *   made it, and can never go to an agent already in its chain (A → B → A).
 * - **States:** done is `kept`, declined is `dropped` with a required note, and `missed` is only
 *   ever an agent's own promise. A to-do somebody gave stays open past its date.
 * - Every change is an audit row naming the actor, the chain depth and the authority applied.
 *
 * @module services/commitments/todo-service
 */
import { ulid } from 'ulidx';
import type { CommitmentRow } from '@dorkos/db';
import type { AuditChange } from '@dorkos/shared/audit-schemas';
import type { CommitmentState } from '@dorkos/shared/commitment-schemas';
import { recordAudit } from '../audit/audit-trail.js';
import { mergeMarks, NO_MARKS, type TurnMarks } from '../core/turn-power/turn-marks.js';
import {
  agentWordsMarks,
  authorityOf,
  floorAfter,
  lowerAuthority,
  ownWordsAuthority,
  readAuthority,
  writeAuthority,
  writeAuthorityMarks,
  type TodoActor,
  type WritableCommitmentAuthority,
} from './commitment-authority.js';
import {
  COMMITMENT_DUE_SKEW_MS,
  CommitmentError,
  isOverdue,
  isOwnPromise,
  PERSON_ASSIGNER,
} from './commitment-service.js';
import { mayChangeState, mayEdit, mayRank, mayReassign } from './todo-policy.js';
import type { TodoPatch, TodoStore } from './todo-store.js';

/** Who a to-do is assigned to. */
export type TodoAssignee =
  | { readonly kind: 'agent'; readonly agentId: string }
  | { readonly kind: 'person'; readonly account: string };

/** The message a to-do was made from, as the server read it. */
export interface TodoSource {
  /** The room entry. */
  readonly entryId: string;
  /** Who wrote it, recorded apart from the assigner. */
  readonly author: string;
  /** The marks its author carries: an outsider's or a teammate's words keep their mark (Must 2). */
  readonly marks: TurnMarks;
  /** Whether the title is still the source's words, unedited. */
  readonly titleFromSource: boolean;
}

/** What a new to-do carries. Who made it and how strong it is are not here: the server sets them. */
export interface NewTodo {
  /** The title, one line. */
  readonly what: string;
  /** Who it is for. */
  readonly assignee: TodoAssignee;
  /** Who it is ultimately for, when that differs from the assigner. */
  readonly to?: string;
  /** When it is due (ISO 8601). */
  readonly dueAt?: string;
  /** The room it came from or belongs to. */
  readonly roomId?: string;
  /** Short markdown notes. */
  readonly notes?: string;
  /** The assignee's sort key. */
  readonly rank?: string;
  /** The message it was made from. */
  readonly source?: TodoSource;
}

/** A change to a to-do. Every field is optional; at least one must change something. */
export interface TodoChange {
  /** `kept` (done), `dropped` (declined, with a note), or `open` (reopen). */
  readonly state?: Extract<CommitmentState, 'open' | 'kept' | 'dropped'>;
  /** How it ended, or why it was declined. Required with `dropped`. */
  readonly note?: string;
  /** A new title. */
  readonly what?: string;
  /** New notes, or null to clear them. */
  readonly notes?: string | null;
  /** A new due date, or null to clear it. */
  readonly dueAt?: string | null;
  /** A new assignee. */
  readonly assignee?: TodoAssignee;
  /** A new sort key, or null to unrank it. */
  readonly rank?: string | null;
  /** The state the caller believes it is in; a mismatch is refused with `CONFLICT`. */
  readonly from?: CommitmentState;
}

/**
 * The to-do whose turn the actor is acting in, as the turns layer recorded it. Never from a caller:
 * an agent cannot claim a shallower chain.
 */
export interface TodoParent {
  /** That to-do's chain depth. */
  readonly depth: number;
  /** The agents already in its chain. */
  readonly agents: readonly string[];
}

/** A to-do, as readers see it. Its stored authority stays on the server. */
export interface Todo {
  id: string;
  what: string;
  assignee: TodoAssignee;
  assignedBy: { kind: CommitmentRow['assignedByKind']; id: string };
  to: string | null;
  dueAt: string | null;
  state: CommitmentState;
  overdue: boolean;
  roomId: string | null;
  sourceEntryId: string | null;
  sourceAuthor: string | null;
  titleFromSource: boolean;
  notes: string | null;
  note: string | null;
  rank: string | null;
  chainDepth: number;
  /**
   * True when the to-do runs at the stranger bound (Security, #3454): an outsider touched it, a
   * person who did not prove it made or changed it, or nobody could vouch for who did. Shown on
   * the to-do so the drop is never silent.
   */
  strangerBound: boolean;
  createdAt: string;
  closedAt: string | null;
}

/** What the service is built from. */
export interface TodoServiceDeps {
  /** The table. */
  store: TodoStore;
  /** Whether an agent id is on the team. */
  agentExists(agentId: string): boolean;
  /**
   * Whether one agent may give another a to-do: both in the same space, from Mesh's and the
   * space's own records, never from anything the caller sends.
   */
  mayAssign(fromAgentId: string, toAgentId: string): boolean;
  /** Re-arm (or clear) the due timer for a row after it changed. */
  rearm(id: string): void;
  /**
   * A to-do now asks an agent to act: made for it, reassigned to it, or reopened by the person. The
   * turns layer decides whether a turn starts (`todo-turns.ts`). Called after the row is written,
   * with whose spend the turn counts against: the acting agent, `outsider:<id>`, or null for the
   * person.
   */
  onTurnable?(row: CommitmentRow, chargedTo: string | null): void;
  /** The clock (tests pin it). */
  now?: () => Date;
}

/**
 * Read the stored chain. An unreadable chain is refused rather than read as empty: an empty chain
 * would let the to-do go back to an agent already in it.
 */
function readChain(stored: string): string[] {
  const value: unknown = JSON.parse(stored);
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new Error('commitments.chain_agents is not a list of agent ids');
  }
  return value;
}

/**
 * Turn a stored row into what readers see.
 *
 * @param row - The stored row.
 * @param now - The moment to judge overdue at, in epoch ms.
 */
export function toTodo(row: CommitmentRow, now: number): Todo {
  return {
    id: row.id,
    what: row.what,
    assignee: row.agentId
      ? { kind: 'agent', agentId: row.agentId }
      : { kind: 'person', account: row.ownerAccount! },
    assignedBy: { kind: row.assignedByKind, id: row.assignedBy },
    to: row.toAccount,
    dueAt: row.dueAt,
    state: row.state,
    overdue: isOverdue(row, now),
    roomId: row.roomId,
    sourceEntryId: row.sourceRoomEntryId,
    sourceAuthor: row.sourceAuthor,
    titleFromSource: row.titleFromSource,
    notes: row.notes,
    note: row.note,
    rank: row.rank,
    chainDepth: row.chainDepth,
    strangerBound: readAuthority(row.authority).kind === 'runtime-default',
    createdAt: row.createdAt,
    closedAt: row.closedAt,
  };
}

/** How many to-dos one agent may give people in a day; past it, a plain refusal (PM, 2026-10-19). */
export const TODOS_TO_PEOPLE_PER_AGENT_PER_DAY = 5;

/** Makes and changes to-dos. */
export class TodoService {
  private readonly now: () => Date;

  /**
   * Build the service.
   *
   * @param deps - The store, the team lookups, the timer hook and the clock.
   */
  constructor(private readonly deps: TodoServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * One to-do, or undefined.
   *
   * @param id - The to-do id.
   */
  get(id: string): Todo | undefined {
    const row = this.deps.store.get(id);
    return row ? toTodo(row, this.now().getTime()) : undefined;
  }

  /**
   * Make a to-do.
   *
   * @param actor - Who is making it, as the server established it.
   * @param input - What it is and who it is for.
   * @param parent - The to-do whose turn the actor is in, when the turns layer recorded one.
   * @throws {CommitmentError} `UNKNOWN_AGENT`, `NOT_YOURS` (another space, or an agent already in
   *   the chain), `NOTHING_TO_CHANGE` (an empty title) or `PAST_DUE`.
   */
  create(actor: TodoActor, input: NewTodo, parent?: TodoParent): Todo {
    const what = this.title(input.what);
    this.checkAssignee(input.assignee);
    if (actor.kind === 'agent' && input.assignee.kind === 'person') {
      this.checkDailyCap(actor.agentId);
    }
    const chain = this.chainFor(actor, input.assignee, parent);
    const own =
      actor.kind === 'agent' &&
      input.assignee.kind === 'agent' &&
      input.assignee.agentId === actor.agentId
        ? // A note to self: the agent's own words, held to its turn's level, as a promise is.
          {
            authority: ownWordsAuthority(actor.level),
            marks: agentWordsMarks(actor.level, actor.marks),
          }
        : authorityOf(actor);
    const sourceMarks = input.source?.marks ?? NO_MARKS;
    // An outsider's words in the source hold the whole to-do to the stranger bound (Must 2).
    const authority = sourceMarks.outsider
      ? (lowerAuthority(own.authority, { kind: 'runtime-default' }) as WritableCommitmentAuthority)
      : own.authority;
    const row: CommitmentRow = {
      id: ulid(),
      agentId: input.assignee.kind === 'agent' ? input.assignee.agentId : null,
      ownerAccount: input.assignee.kind === 'person' ? input.assignee.account : null,
      toAccount: input.to ?? null,
      what,
      dueAt: input.dueAt ? this.futureDue(input.dueAt) : null,
      state: 'open',
      sourceSessionId: null,
      sourceRoomEntryId: input.source?.entryId ?? null,
      createdAt: this.now().toISOString(),
      dueNotifiedAt: null,
      closedAt: null,
      note: null,
      originMarks: null,
      assignedByKind: actor.kind,
      assignedBy:
        actor.kind === 'agent'
          ? actor.agentId
          : actor.kind === 'person'
            ? PERSON_ASSIGNER
            : actor.id,
      authority: writeAuthority(authority),
      authorityMarks: writeAuthorityMarks(mergeMarks(own.marks, sourceMarks)),
      chainDepth: chain.depth,
      chainAgents: JSON.stringify(chain.agents),
      titleFromSource: input.source?.titleFromSource ?? false,
      sourceAuthor: input.source?.author ?? null,
      roomId: input.roomId ?? null,
      notes: input.notes ?? null,
      rank: input.rank ?? null,
    };
    this.deps.store.insert(row);
    this.audit(row, actor, 'todo.created', 'create', [
      { field: 'state', after: 'open' },
      { field: 'assignee', after: assigneeLabel(row) },
      { field: 'authority', after: row.authority },
      ...(row.sourceRoomEntryId ? [{ field: 'sourceEntryId', after: row.sourceRoomEntryId }] : []),
    ]);
    if (actor.kind === 'agent' && row.ownerAccount) {
      this.deps.store.recordPersonAsk(actor.agentId, row.id, row.createdAt);
    }
    this.deps.rearm(row.id);
    if (row.agentId) this.deps.onTurnable?.(row, chargeOf(actor));
    return toTodo(row, this.now().getTime());
  }

  /**
   * Change a to-do: its state, title, notes, due date, assignee or order.
   *
   * @param actor - Who is changing it, as the server established it.
   * @param id - The to-do id.
   * @param change - What changes.
   * @param parent - The to-do whose turn the actor is in, when the turns layer recorded one.
   * @throws {CommitmentError} `NOT_FOUND`, `NOT_YOURS`, `CONFLICT`, `NOTHING_TO_CHANGE`,
   *   `UNKNOWN_AGENT` or `PAST_DUE`.
   */
  update(actor: TodoActor, id: string, change: TodoChange, parent?: TodoParent): Todo {
    const row = this.deps.store.get(id);
    if (!row) throw new CommitmentError('NOT_FOUND', 'No to-do has that id.');
    // An agent's own promise keeps its own rules (`missed`, the reopen grace) in one place.
    if (isOwnPromise(row)) {
      throw new CommitmentError(
        'NOTHING_TO_CHANGE',
        "That is an agent's own promise. Change it as a promise, not as a to-do."
      );
    }
    if (change.from !== undefined && change.from !== row.state) {
      throw new CommitmentError(
        'CONFLICT',
        `That to-do is ${row.state} now, not ${change.from}. Nothing changed.`
      );
    }
    const patch: TodoPatch = {};
    const audit: AuditChange[] = [];
    let action = 'todo.edited';
    let touchesWords = false;

    if (change.state !== undefined && change.state !== row.state) {
      this.require(
        mayChangeState(row, actor),
        'Only the person, or the agent it is assigned to, can change whether it is done.'
      );
      if (change.state === 'dropped' && !change.note?.trim()) {
        throw new CommitmentError('NOTHING_TO_CHANGE', 'Say why in a note when declining a to-do.');
      }
      patch.state = change.state;
      patch.closedAt = change.state === 'open' ? null : this.now().toISOString();
      audit.push({ field: 'state', before: row.state, after: change.state });
      action =
        change.state === 'kept'
          ? 'todo.kept'
          : change.state === 'dropped'
            ? 'todo.dropped'
            : 'todo.reopened';
      touchesWords = true;
    }
    if (change.note !== undefined) {
      this.require(
        mayChangeState(row, actor),
        'Only the person, or the agent it is assigned to, can write how it ended.'
      );
      patch.note = change.note.trim() || null;
    }
    if (change.what !== undefined && change.what !== row.what) {
      this.require(
        mayEdit(row, actor),
        'Only the person, its assignee or the agent that made it can edit it.'
      );
      patch.what = this.title(change.what);
      // Rewritten, so no longer the source's words.
      patch.titleFromSource = false;
      audit.push({ field: 'what', before: row.what, after: patch.what });
      touchesWords = true;
    }
    if (change.notes !== undefined && change.notes !== row.notes) {
      this.require(
        mayEdit(row, actor),
        'Only the person, its assignee or the agent that made it can edit it.'
      );
      patch.notes = change.notes;
      audit.push({ field: 'notes', before: row.notes, after: change.notes });
      touchesWords = true;
    }
    if (change.dueAt !== undefined) {
      this.require(
        mayEdit(row, actor),
        'Only the person, its assignee or the agent that made it can move its date.'
      );
      const nextDue = change.dueAt ? this.futureDue(change.dueAt) : null;
      if (nextDue !== row.dueAt) {
        patch.dueAt = nextDue;
        patch.dueNotifiedAt = null;
        audit.push({ field: 'dueAt', before: row.dueAt, after: nextDue });
      }
    }
    if (change.assignee !== undefined && assigneeLabel(row) !== labelOf(change.assignee)) {
      this.require(
        mayReassign(row, actor),
        'Only the person, or the agent that made it, can reassign it.'
      );
      this.checkAssignee(change.assignee);
      if (actor.kind === 'agent' && change.assignee.kind === 'person') {
        this.checkDailyCap(actor.agentId);
      }
      const chain = this.reassignChain(row, actor, change.assignee, parent);
      patch.agentId = change.assignee.kind === 'agent' ? change.assignee.agentId : null;
      patch.ownerAccount = change.assignee.kind === 'person' ? change.assignee.account : null;
      patch.chainDepth = chain.depth;
      patch.chainAgents = JSON.stringify(chain.agents);
      patch.dueNotifiedAt = null;
      audit.push({
        field: 'assignee',
        before: assigneeLabel(row),
        after: labelOf(change.assignee),
      });
      action = 'todo.reassigned';
      touchesWords = true;
    }
    if (change.rank !== undefined && change.rank !== row.rank) {
      this.require(
        mayRank(row, actor),
        'Only the person, or the agent it is assigned to, can move it in their order.'
      );
      patch.rank = change.rank;
      audit.push({ field: 'rank', before: row.rank, after: change.rank });
    }
    if (Object.keys(patch).length === 0) {
      throw new CommitmentError('NOTHING_TO_CHANGE', 'Nothing to change.');
    }
    if (touchesWords) {
      const floor = floorAfter(row, actor);
      if (floor.authority !== row.authority) {
        audit.push({ field: 'authority', before: row.authority, after: floor.authority });
      }
      Object.assign(patch, floor);
    }
    const updated = this.deps.store.update(row.id, patch)!;
    this.audit(updated, actor, action, 'modify', audit, change.note);
    this.deps.rearm(row.id);
    if (action === 'todo.reassigned' && actor.kind === 'agent' && updated.ownerAccount) {
      this.deps.store.recordPersonAsk(actor.agentId, updated.id, this.now().toISOString());
    }
    // A reassignment asks the new assignee to act. A reopen does only when the person did it: an
    // agent closing and reopening a to-do assigned to it must not be a way to start turns.
    const asksAgain =
      action === 'todo.reassigned' ||
      (action === 'todo.reopened' && actor.kind === 'person' && actor.proven);
    if (asksAgain && updated.agentId && updated.state === 'open') {
      this.deps.onTurnable?.(updated, chargeOf(actor));
    }
    return toTodo(updated, this.now().getTime());
  }

  /** Refuse an agent's sixth to-do for people today with `TOO_MANY`. */
  private checkDailyCap(agentId: string): void {
    const day = this.now().toISOString().slice(0, 10);
    if (this.deps.store.countPersonAsks(agentId, day) >= TODOS_TO_PEOPLE_PER_AGENT_PER_DAY) {
      throw new CommitmentError(
        'TOO_MANY',
        `You have given people ${TODOS_TO_PEOPLE_PER_AGENT_PER_DAY} to-dos today, the most in a day. Wait until tomorrow, or tell them in your chat instead.`
      );
    }
  }

  /** Refuse with `NOT_YOURS` unless the policy allows it. */
  private require(allowed: boolean, message: string): void {
    if (!allowed) throw new CommitmentError('NOT_YOURS', message);
  }

  /** A trimmed, non-empty title. */
  private title(value: string): string {
    const what = value.trim();
    if (!what) throw new CommitmentError('NOTHING_TO_CHANGE', 'A to-do needs a title.');
    return what;
  }

  /** Refuse an agent assignee who is not on the team. */
  private checkAssignee(assignee: TodoAssignee): void {
    if (assignee.kind === 'agent' && !this.deps.agentExists(assignee.agentId)) {
      throw new CommitmentError('UNKNOWN_AGENT', 'No agent on the team has that id.');
    }
  }

  /** The chain a new to-do starts with: a person's at 0, an agent's one deeper than its turn's. */
  private chainFor(
    actor: TodoActor,
    assignee: TodoAssignee,
    parent: TodoParent | undefined
  ): { depth: number; agents: string[] } {
    if (actor.kind !== 'agent') return { depth: 0, agents: [] };
    return this.agentStep(actor.agentId, assignee, parent?.depth ?? 0, parent?.agents ?? []);
  }

  /** The chain after a reassignment: an agent's adds one, a person's keeps it. */
  private reassignChain(
    row: CommitmentRow,
    actor: TodoActor,
    assignee: TodoAssignee,
    parent: TodoParent | undefined
  ): { depth: number; agents: string[] } {
    const stored = readChain(row.chainAgents);
    if (actor.kind !== 'agent') return { depth: row.chainDepth, agents: stored };
    const base = Math.max(row.chainDepth, parent?.depth ?? 0);
    const agents = [...new Set([...stored, ...(parent?.agents ?? [])])];
    return this.agentStep(actor.agentId, assignee, base, agents);
  }

  /** One agent-made step: same space, never back to an agent already in the chain. */
  private agentStep(
    agentId: string,
    assignee: TodoAssignee,
    depth: number,
    agents: readonly string[]
  ): { depth: number; agents: string[] } {
    if (assignee.kind === 'agent' && assignee.agentId !== agentId) {
      if (!this.deps.mayAssign(agentId, assignee.agentId)) {
        throw new CommitmentError(
          'NOT_YOURS',
          'That agent is not in your space, so it cannot get your to-dos.'
        );
      }
      if (agents.includes(assignee.agentId)) {
        throw new CommitmentError(
          'NOT_YOURS',
          'That agent is already in this chain of to-dos. Ask the person instead.'
        );
      }
    }
    return { depth: depth + 1, agents: [...new Set([...agents, agentId])] };
  }

  /** A due date the caller set, normalized, or `PAST_DUE` when it has passed. */
  private futureDue(value: string): string {
    const due = Date.parse(value);
    if (Number.isNaN(due) || due < this.now().getTime() - COMMITMENT_DUE_SKEW_MS) {
      throw new CommitmentError('PAST_DUE', 'That due date has passed. Pick a time ahead.');
    }
    return new Date(value).toISOString();
  }

  /** Write the audit row for one change: the actor, the chain depth and the authority applied. */
  private audit(
    row: CommitmentRow,
    actor: TodoActor,
    action: string,
    operation: 'create' | 'modify',
    change: AuditChange[],
    reason?: string
  ): void {
    recordAudit({
      action,
      operation,
      target: {
        type: 'todo',
        id: row.id,
        containerId: row.agentId ?? row.ownerAccount ?? undefined,
      },
      outcome: 'ok',
      change: [
        ...change,
        { field: 'actor', after: actorLabel(actor) },
        { field: 'chainDepth', after: row.chainDepth },
        { field: 'authorityApplied', after: row.authority },
        ...(row.sourceRoomEntryId
          ? [{ field: 'sourceEntryId', after: row.sourceRoomEntryId }]
          : []),
      ],
      ...(reason ? { reason } : {}),
      summary: row.what,
      visibility: 'space',
    });
  }
}

/**
 * Whose spend a turn an actor asked for counts against. Only a proven person is never charged; a
 * request that did not prove the person could be any program here, so it shares one capped charge.
 */
function chargeOf(actor: TodoActor): string | null {
  if (actor.kind === 'agent') return actor.agentId;
  if (actor.kind === 'outsider') return `outsider:${actor.id}`;
  return actor.proven ? null : 'unproven-person';
}

/** `agent:<id>` or `person:<account>`, for a row's assignee. */
function assigneeLabel(row: Pick<CommitmentRow, 'agentId' | 'ownerAccount'>): string {
  return row.agentId ? `agent:${row.agentId}` : `person:${row.ownerAccount}`;
}

/** The same label for an assignee. */
function labelOf(assignee: TodoAssignee): string {
  return assignee.kind === 'agent' ? `agent:${assignee.agentId}` : `person:${assignee.account}`;
}

/** Who acted, for the audit row. */
function actorLabel(actor: TodoActor): string {
  if (actor.kind === 'agent') return `agent:${actor.agentId}`;
  if (actor.kind === 'outsider') return `outsider:${actor.id}`;
  return actor.proven ? 'person' : 'person:unproven';
}
