/**
 * Commitments: what an agent promised, to whom, by when (spec `heartbeats` §12,
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
 * @module services/commitments/commitment-service
 */
import { ulid } from 'ulidx';
import type { CommitmentRow } from '@dorkos/db';
import type { Commitment, CommitmentState } from '@dorkos/shared/commitment-schemas';
import type { AuditChange } from '@dorkos/shared/audit-schemas';
import { recordAudit } from '../audit/audit-trail.js';
import { runOutsideAuditScope } from '../audit/audit-context.js';
import { logger } from '../../lib/logger.js';
import { COMMITMENT_MISSED_AFTER_MS, CommitmentDueTimers } from './commitment-due-timers.js';
import {
  COMMITMENT_LIST_LIMIT,
  type CommitmentFilter,
  type CommitmentPatch,
  type CommitmentStore,
} from './commitment-store.js';

/** How far in the past a new due date may be, for clock skew between devices. */
export const COMMITMENT_DUE_SKEW_MS = 60 * 1000;

/** The most wakes held for a first observer; older ones are dropped beyond it. */
const PENDING_WAKES_MAX = 500;

/** Why a commitment change was refused. */
export type CommitmentErrorCode =
  | 'NOT_FOUND'
  | 'NOT_YOURS'
  | 'NOTHING_TO_CHANGE'
  | 'CONFLICT'
  | 'PAST_DUE'
  | 'NO_AGENT'
  | 'UNKNOWN_AGENT';

/** A refusal, with a stable code and a plain sentence for whoever asked. */
export class CommitmentError extends Error {
  /**
   * Build a refusal.
   *
   * @param code - The stable code.
   * @param message - A plain sentence for the caller.
   */
  constructor(
    readonly code: CommitmentErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'CommitmentError';
  }
}

/** Who is changing a commitment: the agent by its Mesh id, or a person. */
export type CommitmentActor = { kind: 'agent'; agentId: string } | { kind: 'person' };

/** What a new commitment carries. */
export interface NewCommitment {
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
}

/** A change to a commitment. */
export interface CommitmentChange {
  /**
   * The state it should be in. `open` on an open promise moves its date; on a
   * closed one it reopens it (with a new `dueAt`, or keeping the old one).
   */
  state: CommitmentState;
  /** A new due date, or null to remove it. Only with state `open`. */
  dueAt?: string | null;
  /** A short note on how it ended or why it moved. */
  note?: string;
  /**
   * The state the caller believes it is in now. When given and it differs,
   * the change is refused with `CONFLICT`, so an Undo never reverts a change
   * someone else made since.
   */
  from?: CommitmentState;
}

/** What observers hear when a commitment comes due. */
export interface CommitmentDueEvent {
  /** Always `commitment.due`. */
  type: 'commitment.due';
  /** The commitment, as read at that moment. */
  commitment: Commitment;
}

/** Something listening for commitments coming due. */
export type CommitmentObserver = (event: CommitmentDueEvent) => void;

/** What the service is built from. */
export interface CommitmentServiceDeps {
  /** The table. */
  store: CommitmentStore;
  /** The clock (tests pin it). Defaults to the system clock. */
  now?: () => Date;
}

/** The audit action for a commitment arriving in each closed state. */
const CLOSE_ACTION: Record<Exclude<CommitmentState, 'open'>, string> = {
  kept: 'commitment.kept',
  missed: 'commitment.missed',
  dropped: 'commitment.dropped',
};

/**
 * Whether a commitment is overdue at `now`: open, with a due date in the past.
 *
 * @param row - The stored row.
 * @param now - The moment to judge it at, in epoch ms.
 */
export function isOverdue(row: Pick<CommitmentRow, 'state' | 'dueAt'>, now: number): boolean {
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
export function toCommitment(row: CommitmentRow, now: number): Commitment {
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
function readingOrder(a: Commitment, b: Commitment): number {
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

/** Records, reads and watches commitments. */
export class CommitmentService {
  private readonly store: CommitmentStore;
  private readonly now: () => Date;
  private readonly observers = new Set<CommitmentObserver>();
  private readonly pendingWakes: CommitmentDueEvent[] = [];
  private readonly timers: CommitmentDueTimers;

  /**
   * Build the service. Call {@link start} to arm the due timers.
   *
   * @param deps - The store and the clock.
   */
  constructor(deps: CommitmentServiceDeps) {
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date());
    // Both callbacks run outside whatever audit scope armed the timer: a timer
    // keeps the async context it was created in, and the person or agent whose
    // call set the date is not who marks a promise missed. With no scope,
    // `recordAudit` names DorkOS.
    this.timers = new CommitmentDueTimers({
      now: () => this.now().getTime(),
      onDue: (id) => runOutsideAuditScope(() => this.handleDue(id)),
      onMissed: (id) => runOutsideAuditScope(() => this.handleMissed(id)),
    });
  }

  /** Arm one timer per open commitment with a due date, from the table. */
  start(): void {
    const rows = this.store.openWithDueDate();
    this.timers.rebuild(
      rows.map((row) => ({ id: row.id, dueAt: row.dueAt!, dueNotifiedAt: row.dueNotifiedAt }))
    );
  }

  /** Disarm every timer. */
  stop(): void {
    this.timers.stop();
  }

  /**
   * Listen for commitments coming due. The first observer also receives every
   * wake that fired while nobody was listening (startup).
   *
   * @param fn - Called with each `commitment.due` event.
   * @returns A function that stops listening.
   */
  observe(fn: CommitmentObserver): () => void {
    this.observers.add(fn);
    const held = this.pendingWakes.splice(0);
    for (const event of held) this.deliver(event);
    return () => {
      this.observers.delete(fn);
    };
  }

  /**
   * Commitments matching the filter: every open one (soonest due first), then
   * closed ones, most recently closed first, up to `limit` rows in all.
   *
   * @param filter - Which ones. Anyone may read every agent's list.
   * @param limit - How many rows in all, at most; open ones are never cut.
   */
  list(filter: CommitmentFilter = {}, limit = COMMITMENT_LIST_LIMIT): Commitment[] {
    const now = this.now().getTime();
    return this.store
      .list(filter, limit)
      .map((row) => toCommitment(row, now))
      .sort(readingOrder);
  }

  /**
   * One commitment, or undefined.
   *
   * @param id - The commitment id.
   */
  get(id: string): Commitment | undefined {
    const row = this.store.get(id);
    return row ? toCommitment(row, this.now().getTime()) : undefined;
  }

  /**
   * Record a promise for an agent.
   *
   * The caller decides whose it is: the capability passes the calling agent's
   * own id, the route the agent a person picked.
   *
   * @param agentId - The Mesh id of the agent that promised.
   * @param input - What, to whom, by when, and where it was made.
   * @throws {CommitmentError} `PAST_DUE` when the due date has passed.
   */
  create(agentId: string, input: NewCommitment): Commitment {
    const dueAt = input.dueAt ? this.futureDue(input.dueAt) : null;
    const row: CommitmentRow = {
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
    };
    this.store.insert(row);
    this.audit(row, 'commitment.created', 'create', [
      { field: 'state', after: 'open' },
      ...(row.dueAt ? [{ field: 'dueAt', after: row.dueAt }] : []),
      ...(row.toAccount ? [{ field: 'to', after: row.toAccount }] : []),
    ]);
    this.arm(row);
    return toCommitment(row, this.now().getTime());
  }

  /**
   * Change a commitment: close it, move its date, or reopen it.
   *
   * @param actor - Who is changing it. Another agent is refused.
   * @param id - The commitment id.
   * @param change - The new state, and optionally a new due date and a note.
   * @throws {CommitmentError} `NOT_FOUND`, `NOT_YOURS`, `NOTHING_TO_CHANGE` or `PAST_DUE`.
   */
  update(actor: CommitmentActor, id: string, change: CommitmentChange): Commitment {
    const row = this.store.get(id);
    if (!row) throw new CommitmentError('NOT_FOUND', 'No promise has that id.');
    if (actor.kind === 'agent' && actor.agentId !== row.agentId) {
      throw new CommitmentError(
        'NOT_YOURS',
        'That promise belongs to another agent. Only that agent or a person can change it.'
      );
    }
    if (change.from !== undefined && change.from !== row.state) {
      throw new CommitmentError(
        'CONFLICT',
        `That promise is ${row.state} now, not ${change.from}. Nothing changed.`
      );
    }
    if (change.state === 'open') {
      return row.state === 'open' ? this.move(row, change) : this.reopen(row, change);
    }
    if (change.dueAt !== undefined) {
      throw new CommitmentError(
        'NOTHING_TO_CHANGE',
        'A new due date applies only with state open. Leave dueAt out to close it.'
      );
    }
    if (change.state === row.state) {
      if (change.note !== undefined) return this.saveNote(row, change.note);
      throw new CommitmentError('NOTHING_TO_CHANGE', `That promise is already ${row.state}.`);
    }
    return this.close(row, change.state, change.note);
  }

  /** A due date the caller set, normalized, or `PAST_DUE` when it has passed. */
  private futureDue(value: string): string {
    const due = Date.parse(value);
    if (Number.isNaN(due) || due < this.now().getTime() - COMMITMENT_DUE_SKEW_MS) {
      throw new CommitmentError('PAST_DUE', 'That due date has passed. Pick a time ahead.');
    }
    return normalizeIso(value);
  }

  /** Move an open promise's due date. A new date gets a new wake. */
  private move(row: CommitmentRow, change: CommitmentChange): Commitment {
    const nextDue =
      change.dueAt === undefined ? row.dueAt : change.dueAt ? this.futureDue(change.dueAt) : null;
    if (nextDue === row.dueAt) {
      if (change.note !== undefined) return this.saveNote(row, change.note);
      throw new CommitmentError(
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
    return toCommitment(updated, this.now().getTime());
  }

  /**
   * Reopen a closed promise: with a new due date, or keeping the old one (the
   * app's Undo). An old date already past is due now: woken now if it never
   * was, and either way given a fresh hour rather than a missed mark the moment
   * it reopens.
   */
  private reopen(row: CommitmentRow, change: CommitmentChange): Commitment {
    const dateMoves = change.dueAt !== undefined;
    const nextDue = dateMoves ? (change.dueAt ? this.futureDue(change.dueAt) : null) : row.dueAt;
    const now = this.now();
    const pastDue = nextDue !== null && Date.parse(nextDue) <= now.getTime();
    const patch: CommitmentPatch = {
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
    return toCommitment(updated, now.getTime());
  }

  /** Save a note and nothing else, recorded as a change to the promise. */
  private saveNote(row: CommitmentRow, note: string): Commitment {
    const updated = this.store.update(row.id, { note: note || null })!;
    this.audit(
      updated,
      'commitment.noted',
      'modify',
      [{ field: 'note', before: row.note, after: updated.note }],
      note
    );
    return toCommitment(updated, this.now().getTime());
  }

  /** Close a promise as kept, missed or dropped. */
  private close(
    row: CommitmentRow,
    state: Exclude<CommitmentState, 'open'>,
    note: string | undefined
  ): Commitment {
    const patch: CommitmentPatch = {
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
    return toCommitment(updated, this.now().getTime());
  }

  /** Arm (or clear) the timer for a row as it now stands. */
  private arm(row: CommitmentRow): void {
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
    const event: CommitmentDueEvent = {
      type: 'commitment.due',
      commitment: toCommitment(updated, this.now().getTime()),
    };
    if (this.observers.size === 0) {
      this.pendingWakes.push(event);
      if (this.pendingWakes.length > PENDING_WAKES_MAX) this.pendingWakes.shift();
      return;
    }
    this.deliver(event);
  }

  /** Hand one wake to every observer; one that throws never stops the rest. */
  private deliver(event: CommitmentDueEvent): void {
    for (const observer of this.observers) {
      try {
        observer(event);
      } catch (err) {
        logger.warn('[commitments] a commitment.due observer threw', {
          id: event.commitment.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** An hour past the wake: mark it missed, if nobody kept it or moved the date. */
  private handleMissed(id: string): void {
    const row = this.store.get(id);
    if (!row || row.state !== 'open' || !row.dueAt || !row.dueNotifiedAt) return;
    // A date moved since this timer was armed clears the wake and re-arms; only
    // a promise still open an hour after its wake is missed.
    if (Date.parse(row.dueNotifiedAt) + COMMITMENT_MISSED_AFTER_MS > this.now().getTime()) return;
    this.close(row, 'missed', undefined);
  }

  /** Write the audit row for one change. The summary is the promise itself, nothing more. */
  private audit(
    row: CommitmentRow,
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
