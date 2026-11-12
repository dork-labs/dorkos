/**
 * To-dos: what an agent promised, to whom, by when (spec `heartbeats` §12,
 * canon PROACTIVE-AGENTS §5.5).
 *
 * One service behind the three capabilities and the three routes, so the rules
 * hold whichever way a change arrives:
 *
 * - An agent records its own promises only. A person may add one for any agent.
 * - Only the agent that promised, or a person, may change one. Another agent may
 *   read it but never close or reopen it (`NOT_YOURS`).
 * - A due date is never in the past when it is set (`PAST_DUE`).
 * - Overdue is computed on every read (`open` and due in the past), never stored.
 * - Every change is an audit row (`commitment.created|kept|missed|dropped|moved|reopened|noted`),
 *   readable by everyone in the space.
 * - When a promise comes due, observers hear `commitment.due` once per due date
 *   (`due_notified_at`); an hour after that wake a promise still open is marked
 *   `missed`. A promise found late (a restart, a computer that slept) is due now
 *   and gets a fresh hour.
 *
 * ## Wakes before anyone listens
 *
 * The heartbeat runner (DOR-2788 PR 3) subscribes after boot, so a wake that
 * fires while nobody is subscribed (startup finds promises already due) is
 * queued in memory and delivered to the FIRST `observe()` call. A queued wake
 * lost to a restart before anyone subscribed is not repeated, because
 * `due_notified_at` was already set; the missed mark still lands an hour later.
 *
 * @module services/todos/todo-promise-service
 */
import { ulid } from 'ulidx';
import type { TodoRow } from '@dorkos/db';
import type { TodoPromise, TodoState } from '@dorkos/shared/todo-promise-schemas';
import type { AuditChange } from '@dorkos/shared/audit-schemas';
import { recordAudit } from '../audit/audit-trail.js';
import { runOutsideAuditScope } from '../audit/audit-context.js';
import { logger } from '../../lib/logger.js';
import { TODO_MISSED_AFTER_MS, TodoDueTimers } from './todo-due-timers.js';
import {
  TODO_LIST_LIMIT,
  type AgentTodoRow,
  type TodoPromiseFilter,
  type TodoPromisePatch,
  type TodoPromiseStore,
} from './todo-promise-store.js';
import {
  agentWordsMarks,
  authorityOf,
  floorAfter,
  lowerAuthority,
  ownWordsAuthority,
  readAuthority,
  readAuthorityMarks,
  writeAuthority,
  writeAuthorityMarks,
  type WritableTodoAuthority,
} from './todo-authority.js';
import type {
  TurnPermissionBound,
  TurnPermissionCeiling,
  TurnPermissionLevel,
} from '@dorkos/shared/agent-runtime';
import { todoTurnPower } from './todo-turn-power.js';
import {
  hasMarks,
  mergeMarks,
  NO_MARKS,
  parseStoredMarks,
  type TurnMarks,
} from '../core/turn-power/turn-marks.js';

/**
 * Who a person-made to-do names as its assigner. This DorkOS has one owner, and the
 * person routes vouch only for them; to-dos from other people name their own account (DOR-3088).
 */
export const PERSON_ASSIGNER = 'owner';

/** How far in the past a new due date may be, for clock skew between devices. */
export const TODO_DUE_SKEW_MS = 60 * 1000;

/** The most wakes held for a first observer; older ones are dropped beyond it. */
const PENDING_WAKES_MAX = 500;

/** Why a to-do change was refused. */
export type TodoPromiseErrorCode =
  | 'NOT_FOUND'
  | 'NOT_YOURS'
  | 'NOTHING_TO_CHANGE'
  | 'CONFLICT'
  | 'PAST_DUE'
  | 'NO_AGENT'
  | 'UNKNOWN_AGENT'
  | 'TOO_MANY';

/** A refusal, with a stable code and a plain sentence for whoever asked. */
export class TodoPromiseError extends Error {
  /**
   * Build a refusal.
   *
   * @param code - The stable code.
   * @param message - A plain sentence for the caller.
   */
  constructor(
    readonly code: TodoPromiseErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'TodoPromiseError';
  }
}

/** Who is changing a to-do: the agent by its Mesh id, or a person. */
export type TodoPromiseActor =
  | {
      kind: 'agent';
      agentId: string;
      /** The level of the turn it acts from, when known (DOR-3088, Security's Must 3). */
      level?: Pick<TurnPermissionLevel, 'asks' | 'reach' | 'auto'>;
      /** The marks of that turn. */
      marks?: TurnMarks;
    }
  | {
      kind: 'person';
      /**
       * True only for a request carrying the owner's own session cookie (`personProof`). A person
       * who did not prove it writes the stranger bound, never `person` authority.
       */
      proven?: boolean;
    };

/**
 * Whether a row is an agent's own promise, made by that agent for itself: the only kind DorkOS
 * marks `missed`. A to-do somebody else gave stays open past its date (DOR-3088).
 *
 * @param row - The stored row.
 */
export function isOwnPromise(
  row: Pick<TodoRow, 'agentId' | 'assignedByKind' | 'assignedBy'>
): boolean {
  return row.agentId !== null && row.assignedByKind === 'agent' && row.assignedBy === row.agentId;
}

/** What a new to-do carries. */
export interface NewTodoPromise {
  /** What was promised. */
  what: string;
  /** To whom, or omitted. */
  to?: string;
  /** When it is due (ISO 8601), or omitted. Never in the past. */
  dueAt?: string;
  /** The chat it was made in. */
  sourceSessionId?: string;
  /** The room message it was made in. */
  sourceRoomEntryId?: string;
  /**
   * The marks of the turn it was made in (DOR-3036), from that turn's own record. The beat its
   * due date wakes reads the promise, so it carries them on.
   */
  originMarks?: TurnMarks;
  /**
   * The level of the turn it was made in, when known (DOR-3088, Must 1): the promise is held to
   * it. Unknown keeps the agent's own standing, as every promise had before to-dos.
   */
  originLevel?: Pick<TurnPermissionLevel, 'asks' | 'reach' | 'auto'>;
}

/** A change to a to-do. */
export interface TodoPromiseChange {
  /**
   * The state it should be in. `open` on an open promise moves its date; on a
   * closed one it reopens it (with a new `dueAt`, or keeping the old one).
   */
  state: TodoState;
  /** A new due date, or null to remove it. Only with state `open`. */
  dueAt?: string | null;
  /** A short note on how it ended or why it moved. */
  note?: string;
  /**
   * The state the caller believes it is in now. When given and it differs,
   * the change is refused with `CONFLICT`, so an Undo never reverts a change
   * someone else made since.
   */
  from?: TodoState;
}

/** What observers hear when a to-do comes due. */
export interface TodoPromiseDueEvent {
  /** Always `commitment.due`. */
  type: 'commitment.due';
  /** The to-do, as read at that moment. */
  todoPromise: TodoPromise;
}

/** Something listening for to-dos coming due. */
export type TodoPromiseObserver = (event: TodoPromiseDueEvent) => void;

/** What the service is built from. */
export interface TodoPromiseServiceDeps {
  /** The table. */
  store: TodoPromiseStore;
  /** The clock (tests pin it). Defaults to the system clock. */
  now?: () => Date;
}

/** The audit action for a to-do arriving in each closed state. */
const CLOSE_ACTION: Record<Exclude<TodoState, 'open'>, string> = {
  kept: 'commitment.kept',
  missed: 'commitment.missed',
  dropped: 'commitment.dropped',
};

/**
 * Whether a to-do is overdue at `now`: open, with a due date in the past.
 *
 * @param row - The stored row.
 * @param now - The moment to judge it at, in epoch ms.
 */
export function isOverdue(row: Pick<AgentTodoRow, 'state' | 'dueAt'>, now: number): boolean {
  if (row.state !== 'open' || !row.dueAt) return false;
  const due = Date.parse(row.dueAt);
  return !Number.isNaN(due) && due < now;
}

/**
 * Turn a stored row into what readers see, computing `overdue`.
 *
 * @param row - The stored row.
 * @param now - The moment to judge overdue at, in epoch ms.
 */
function toTodoPromise(row: AgentTodoRow, now: number): TodoPromise {
  return {
    id: row.id,
    agentId: row.agentId,
    to: row.toAccount,
    what: row.what,
    dueAt: row.dueAt,
    state: row.state,
    overdue: isOverdue(row, now),
    sourceSessionId: row.sourceSessionId,
    sourceRoomEntryId: row.sourceRoomEntryId,
    createdAt: row.createdAt,
    closedAt: row.closedAt,
    note: row.note,
  };
}

/** Normalize an ISO date-time to UTC `Z` form, so stored dates sort and compare alike. */
function normalizeIso(value: string): string {
  return new Date(value).toISOString();
}

/** Open first, soonest due first (no date last); closed ones most recently closed first. */
function readingOrder(a: TodoPromise, b: TodoPromise): number {
  const openA = a.state === 'open' ? 0 : 1;
  const openB = b.state === 'open' ? 0 : 1;
  if (openA !== openB) return openA - openB;
  if (a.state === 'open') {
    if (a.dueAt && b.dueAt && a.dueAt !== b.dueAt) return a.dueAt < b.dueAt ? -1 : 1;
    if (a.dueAt && !b.dueAt) return -1;
    if (!a.dueAt && b.dueAt) return 1;
  }
  if (a.state !== 'open') {
    const ca = a.closedAt ?? '';
    const cb = b.closedAt ?? '';
    if (ca !== cb) return ca < cb ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  }
  return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
}

/** Records, reads and watches to-dos. */
export class TodoPromiseService {
  private readonly store: TodoPromiseStore;
  private readonly now: () => Date;
  private readonly observers = new Set<TodoPromiseObserver>();
  private readonly pendingWakes: TodoPromiseDueEvent[] = [];
  private readonly timers: TodoDueTimers;

  /**
   * Build the service. Call {@link start} to arm the due timers.
   *
   * @param deps - The store and the clock.
   */
  constructor(deps: TodoPromiseServiceDeps) {
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date());
    // Both callbacks run outside whatever audit scope armed the timer: a timer
    // keeps the async context it was created in, and the person or agent whose
    // call set the date is not who marks a promise missed. With no scope,
    // `recordAudit` names DorkOS.
    this.timers = new TodoDueTimers({
      now: () => this.now().getTime(),
      onDue: (id) => runOutsideAuditScope(() => this.handleDue(id)),
      onMissed: (id) => runOutsideAuditScope(() => this.handleMissed(id)),
    });
  }

  /** Arm one timer per open to-do with a due date, from the table. */
  start(): void {
    const rows = this.store.openWithDueDate();
    this.timers.rebuild(
      rows.map((row) => ({ id: row.id, dueAt: row.dueAt!, dueNotifiedAt: row.dueNotifiedAt }))
    );
  }

  /**
   * Arm or clear one row's due timer after something else changed it (the to-dos service). A
   * to-do a person owns has no agent to wake, so its timer is cleared.
   *
   * @param id - The row id.
   */
  track(id: string): void {
    const row = this.store.get(id);
    if (row) this.arm(row);
    else this.timers.clear(id);
  }

  /** Disarm every timer. */
  stop(): void {
    this.timers.stop();
  }

  /**
   * Listen for to-dos coming due. The first observer also receives every
   * wake that fired while nobody was listening (startup).
   *
   * @param fn - Called with each `commitment.due` event.
   * @returns A function that stops listening.
   */
  observe(fn: TodoPromiseObserver): () => void {
    this.observers.add(fn);
    const held = this.pendingWakes.splice(0);
    for (const event of held) this.deliver(event);
    return () => {
      this.observers.delete(fn);
    };
  }

  /**
   * To-dos matching the filter: every open one (soonest due first), then
   * closed ones, most recently closed first, up to `limit` rows in all.
   *
   * @param filter - Which ones. Anyone may read every agent's list.
   * @param limit - How many rows in all, at most; open ones are never cut.
   */
  list(filter: TodoPromiseFilter = {}, limit = TODO_LIST_LIMIT): TodoPromise[] {
    const now = this.now().getTime();
    return this.store
      .list(filter, limit)
      .map((row) => toTodoPromise(row, now))
      .sort(readingOrder);
  }

  /**
   * Every mark an agent's open promises were made under (DOR-3036): what a beat that reads them
   * carries. None when no open promise was made in a marked turn.
   *
   * @param agentId - The agent.
   */
  openMarks(agentId: string): TurnMarks {
    return this.store
      .list({ agentId, state: 'open' }, TODO_LIST_LIMIT)
      .flatMap((row) => [parseStoredMarks(row.originMarks), readAuthorityMarks(row.authorityMarks)])
      .reduce(mergeMarks, NO_MARKS);
  }

  /**
   * Every bound the agent's open to-dos carry (DOR-3088, Security's Must 4): a beat
   * that reads them, and the due wake that starts one, run no stronger than the lowest of them.
   * Undefined when every open one is the agent's own or a person's.
   *
   * @param agentId - The agent.
   */
  openCeiling(agentId: string): TurnPermissionCeiling | undefined {
    const bounds = this.store.list({ agentId, state: 'open' }, TODO_LIST_LIMIT).flatMap((row) => {
      const { ceiling } = todoTurnPower(row);
      if (ceiling === undefined) return [];
      return Array.isArray(ceiling)
        ? (ceiling as TurnPermissionBound[])
        : [ceiling as TurnPermissionBound];
    });
    return bounds.length === 0 ? undefined : bounds;
  }

  /**
   * One to-do, or undefined.
   *
   * @param id - The to-do id.
   */
  get(id: string): TodoPromise | undefined {
    const row = this.store.get(id);
    return row ? toTodoPromise(row, this.now().getTime()) : undefined;
  }

  /**
   * Record a promise for an agent.
   *
   * The caller decides whose it is: the capability passes the calling agent's
   * own id, the route the agent a person picked. Who made it decides the power it
   * carries: an agent's own promise carries `self` and its turn's marks, and only a
   * caller that names a person gets `person`. Left out, it is the agent's own.
   *
   * @param agentId - The Mesh id of the agent that promised.
   * @param input - What, to whom, by when, and where it was made.
   * @param assigner - Who made it: the agent itself (the default), or a person (`person`
   *   authority only when `proven`).
   * @throws {TodoPromiseError} `PAST_DUE` when the due date has passed.
   */
  create(
    agentId: string,
    input: NewTodoPromise,
    assigner: TodoPromiseActor = { kind: 'agent', agentId }
  ): TodoPromise {
    if (assigner.kind === 'agent' && assigner.agentId !== agentId) {
      throw new TodoPromiseError('NOT_YOURS', 'An agent records only its own promises.');
    }
    const dueAt = input.dueAt ? this.futureDue(input.dueAt) : null;
    const own =
      assigner.kind === 'agent'
        ? {
            authority: ownWordsAuthority(input.originLevel),
            marks: agentWordsMarks(input.originLevel, input.originMarks ?? NO_MARKS),
          }
        : authorityOf({ kind: 'person', proven: assigner.proven === true });
    const row: AgentTodoRow = {
      id: ulid(),
      agentId,
      toAccount: input.to ?? null,
      what: input.what,
      dueAt,
      state: 'open',
      sourceSessionId: input.sourceSessionId ?? null,
      sourceRoomEntryId: input.sourceRoomEntryId ?? null,
      createdAt: this.now().toISOString(),
      dueNotifiedAt: null,
      closedAt: null,
      note: null,
      originMarks:
        input.originMarks && hasMarks(input.originMarks) ? JSON.stringify(input.originMarks) : null,
      ownerAccount: null,
      assignedByKind: assigner.kind,
      assignedBy: assigner.kind === 'agent' ? assigner.agentId : PERSON_ASSIGNER,
      authority: writeAuthority(own.authority),
      authorityMarks: writeAuthorityMarks(own.marks),
      chainDepth: 0,
      chainAgents: '[]',
      titleFromSource: false,
      sourceAuthor: null,
      roomId: null,
      notes: null,
      rank: null,
    };
    this.store.insert(row);
    this.audit(row, 'commitment.created', 'create', [
      { field: 'state', after: 'open' },
      ...(row.dueAt ? [{ field: 'dueAt', after: row.dueAt }] : []),
      ...(row.toAccount ? [{ field: 'to', after: row.toAccount }] : []),
    ]);
    this.arm(row);
    return toTodoPromise(row, this.now().getTime());
  }

  /**
   * Change a to-do: close it, move its date, or reopen it.
   *
   * @param actor - Who is changing it. Another agent is refused.
   * @param id - The to-do id.
   * @param change - The new state, and optionally a new due date and a note.
   * @throws {TodoPromiseError} `NOT_FOUND`, `NOT_YOURS`, `NOTHING_TO_CHANGE` or `PAST_DUE`.
   */
  update(actor: TodoPromiseActor, id: string, change: TodoPromiseChange): TodoPromise {
    const row = this.store.get(id);
    if (!row) throw new TodoPromiseError('NOT_FOUND', 'No promise has that id.');
    if (actor.kind === 'agent' && actor.agentId !== row.agentId) {
      throw new TodoPromiseError(
        'NOT_YOURS',
        'That promise belongs to another agent. Only that agent or a person can change it.'
      );
    }
    if (change.from !== undefined && change.from !== row.state) {
      throw new TodoPromiseError(
        'CONFLICT',
        `That promise is ${row.state} now, not ${change.from}. Nothing changed.`
      );
    }
    if (change.state === 'missed' && !isOwnPromise(row)) {
      throw new TodoPromiseError(
        'NOTHING_TO_CHANGE',
        "Only an agent's own promise can be missed. Mark a to-do kept, or dropped with a note."
      );
    }
    if (change.state === 'dropped' && !isOwnPromise(row) && !change.note?.trim()) {
      throw new TodoPromiseError('NOTHING_TO_CHANGE', 'Say why in a note when declining a to-do.');
    }
    const result = this.dispatch(row, change);
    // On an agent's own promise only a change of state reaches what the next wake acts on. On a
    // to-do somebody gave, every change counts: no edit may keep `person` without proof.
    if (!isOwnPromise(row) || change.state !== row.state) this.lowerFloor(row, actor);
    return result;
  }

  /** Apply one change to a row, by the state it asks for. */
  private dispatch(row: AgentTodoRow, change: TodoPromiseChange): TodoPromise {
    if (change.state === 'open') {
      return row.state === 'open' ? this.move(row, change) : this.reopen(row, change);
    }
    if (change.dueAt !== undefined) {
      throw new TodoPromiseError(
        'NOTHING_TO_CHANGE',
        'A new due date applies only with state open. Leave dueAt out to close it.'
      );
    }
    if (change.state === row.state) {
      if (change.note !== undefined) return this.saveNote(row, change.note);
      throw new TodoPromiseError('NOTHING_TO_CHANGE', `That promise is already ${row.state}.`);
    }
    return this.close(row, change.state, change.note);
  }

  /**
   * Lower the row's authority to the lowest of everyone who has changed its state (Security's
   * Must 3), and audit the power applied when it moves.
   *
   * An agent's own promise is the agent's own words whoever closes or reopens it: the agent's own
   * change holds it to its turn's level and marks, and a person's change (proven or not) leaves it
   * alone, since no words of theirs reach the wake. Any other row counts every actor at their own
   * authority, and a person counts as `person` only with proof.
   */
  private lowerFloor(row: AgentTodoRow, actor: TodoPromiseActor): void {
    if (isOwnPromise(row) && actor.kind === 'person') return;
    const floor =
      actor.kind === 'agent' && isOwnPromise(row)
        ? {
            authority: writeAuthority(
              lowerAuthority(
                readAuthority(row.authority),
                ownWordsAuthority(actor.level)
              ) as WritableTodoAuthority
            ),
            authorityMarks: writeAuthorityMarks(
              mergeMarks(
                readAuthorityMarks(row.authorityMarks),
                agentWordsMarks(actor.level, actor.marks ?? NO_MARKS)
              )
            ),
          }
        : floorAfter(
            row,
            actor.kind === 'agent'
              ? {
                  kind: 'agent',
                  agentId: actor.agentId,
                  level: actor.level,
                  marks: actor.marks ?? NO_MARKS,
                }
              : { kind: 'person', proven: actor.proven === true }
          );
    if (floor.authority === row.authority && floor.authorityMarks === row.authorityMarks) return;
    const updated = this.store.update(row.id, floor)!;
    this.audit(updated, 'commitment.authority_lowered', 'modify', [
      { field: 'authority', before: row.authority, after: floor.authority },
      { field: 'authorityMarks', before: row.authorityMarks, after: floor.authorityMarks },
    ]);
  }

  /** A due date the caller set, normalized, or `PAST_DUE` when it has passed. */
  private futureDue(value: string): string {
    const due = Date.parse(value);
    if (Number.isNaN(due) || due < this.now().getTime() - TODO_DUE_SKEW_MS) {
      throw new TodoPromiseError('PAST_DUE', 'That due date has passed. Pick a time ahead.');
    }
    return normalizeIso(value);
  }

  /** Move an open promise's due date. A new date gets a new wake. */
  private move(row: AgentTodoRow, change: TodoPromiseChange): TodoPromise {
    const nextDue =
      change.dueAt === undefined ? row.dueAt : change.dueAt ? this.futureDue(change.dueAt) : null;
    if (nextDue === row.dueAt) {
      if (change.note !== undefined) return this.saveNote(row, change.note);
      throw new TodoPromiseError(
        'NOTHING_TO_CHANGE',
        'Nothing to change. Pass a new dueAt, or a state of kept, missed or dropped.'
      );
    }
    const updated = this.store.update(row.id, {
      dueAt: nextDue,
      dueNotifiedAt: null,
      ...(change.note !== undefined ? { note: change.note || null } : {}),
    })!;
    this.audit(
      updated,
      'commitment.moved',
      'modify',
      [{ field: 'dueAt', before: row.dueAt, after: nextDue }],
      change.note
    );
    this.arm(updated);
    return toTodoPromise(updated, this.now().getTime());
  }

  /**
   * Reopen a closed promise: with a new due date, or keeping the old one (the
   * app's Undo). An old date already past is due now: woken now if it never
   * was, and either way given a fresh hour rather than a missed mark the moment
   * it reopens.
   */
  private reopen(row: AgentTodoRow, change: TodoPromiseChange): TodoPromise {
    const dateMoves = change.dueAt !== undefined;
    const nextDue = dateMoves ? (change.dueAt ? this.futureDue(change.dueAt) : null) : row.dueAt;
    const now = this.now();
    const pastDue = nextDue !== null && Date.parse(nextDue) <= now.getTime();
    const patch: TodoPromisePatch = {
      state: 'open',
      closedAt: null,
      dueAt: nextDue,
      // An old date already woken about gets a fresh hour from now and no
      // second wake; one never woken about is woken now by the timer below.
      dueNotifiedAt: dateMoves
        ? null
        : pastDue && row.dueNotifiedAt
          ? now.toISOString()
          : row.dueNotifiedAt,
      ...(change.note !== undefined ? { note: change.note || null } : {}),
    };
    const updated = this.store.update(row.id, patch)!;
    this.audit(
      updated,
      'commitment.reopened',
      'modify',
      [
        { field: 'state', before: row.state, after: 'open' },
        ...(dateMoves ? [{ field: 'dueAt', before: row.dueAt, after: nextDue }] : []),
      ],
      change.note
    );
    this.arm(updated);
    return toTodoPromise(updated, now.getTime());
  }

  /** Save a note and nothing else, recorded as a change to the promise. */
  private saveNote(row: AgentTodoRow, note: string): TodoPromise {
    const updated = this.store.update(row.id, { note: note || null })!;
    this.audit(
      updated,
      'commitment.noted',
      'modify',
      [{ field: 'note', before: row.note, after: updated.note }],
      note
    );
    return toTodoPromise(updated, this.now().getTime());
  }

  /** Close a promise as kept, missed or dropped. */
  private close(
    row: AgentTodoRow,
    state: Exclude<TodoState, 'open'>,
    note: string | undefined
  ): TodoPromise {
    const patch: TodoPromisePatch = {
      state,
      closedAt: this.now().toISOString(),
      ...(note !== undefined ? { note: note || null } : {}),
    };
    const updated = this.store.update(row.id, patch)!;
    this.timers.clear(row.id);
    this.audit(
      updated,
      CLOSE_ACTION[state],
      'modify',
      [{ field: 'state', before: row.state, after: state }],
      note
    );
    return toTodoPromise(updated, this.now().getTime());
  }

  /** Arm (or clear) the timer for a row as it now stands. */
  private arm(row: AgentTodoRow): void {
    if (row.state === 'open' && row.dueAt) {
      this.timers.schedule({ id: row.id, dueAt: row.dueAt, dueNotifiedAt: row.dueNotifiedAt });
    } else {
      this.timers.clear(row.id);
    }
  }

  /** The due moment arrived: wake observers once for this due date. */
  private handleDue(id: string): void {
    const row = this.store.get(id);
    if (!row || row.state !== 'open' || !row.dueAt || row.dueNotifiedAt) return;
    const updated = this.store.update(id, { dueNotifiedAt: this.now().toISOString() })!;
    const event: TodoPromiseDueEvent = {
      type: 'commitment.due',
      todoPromise: toTodoPromise(updated, this.now().getTime()),
    };
    if (this.observers.size === 0) {
      this.pendingWakes.push(event);
      if (this.pendingWakes.length > PENDING_WAKES_MAX) this.pendingWakes.shift();
      return;
    }
    this.deliver(event);
  }

  /** Hand one wake to every observer; one that throws never stops the rest. */
  private deliver(event: TodoPromiseDueEvent): void {
    for (const observer of this.observers) {
      try {
        observer(event);
      } catch (err) {
        logger.warn('[to-dos] a commitment.due observer threw', {
          id: event.todoPromise.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** An hour past the wake: mark it missed, if nobody kept it or moved the date. */
  private handleMissed(id: string): void {
    const row = this.store.get(id);
    if (!row || row.state !== 'open' || !row.dueAt || !row.dueNotifiedAt) return;
    // A to-do somebody gave stays open past its date; only an agent's own promise is missed.
    if (!isOwnPromise(row)) return;
    // A date moved since this timer was armed clears the wake and re-arms; only
    // a promise still open an hour after its wake is missed.
    if (Date.parse(row.dueNotifiedAt) + TODO_MISSED_AFTER_MS > this.now().getTime()) return;
    this.close(row, 'missed', undefined);
  }

  /** Write the audit row for one change. The summary is the promise itself, nothing more. */
  private audit(
    row: AgentTodoRow,
    action: string,
    operation: 'create' | 'modify',
    change: AuditChange[],
    reason?: string
  ): void {
    recordAudit({
      action,
      operation,
      target: { type: 'commitment', id: row.id, containerId: row.agentId },
      outcome: 'ok',
      change,
      ...(reason ? { reason } : {}),
      summary: row.what,
      visibility: 'space',
    });
  }
}
