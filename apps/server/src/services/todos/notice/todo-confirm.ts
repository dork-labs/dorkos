/**
 * "Kept" asks the person it was promised to (DOR-3034). An agent signing off its own promise is
 * not the same as the person agreeing it happened, so a promise to a person, marked kept by its
 * agent, waits for one answer: **Yes** confirms it, **Not yet** reopens it and wakes the agent at
 * once. The answer is open for a day (`TODO_CONFIRM_WINDOW_MS`, shared with the app); after that
 * it reads as "kept · unconfirmed" and nothing is asked, so the person is given no chore. Promises between agents are never asked.
 *
 * @module services/todos/notice/todo-confirm
 */
import { TODO_CONFIRM_WINDOW_MS, type TodoPromise } from '@dorkos/shared/todo-promise-schemas';
import { recordAudit } from '../../audit/audit-trail.js';
import type { TodoPromiseStore } from '../todo-promise-store.js';
import { TodoPromiseError, type TodoPromiseActor } from '../todo-promise-types.js';
import { toTodoPromise } from '../todo-promise-view.js';

/** A person's answer to "was it kept?". */
export type TodoConfirmAnswer = 'yes' | 'not-yet';

/** What the confirmations are built from. */
export interface TodoConfirmDeps {
  /** The table. */
  store: Pick<TodoPromiseStore, 'get' | 'update'>;
  /** Reopens a promise the way every other reopen does: its timers, its audit, its floor. */
  reopen: (actor: TodoPromiseActor, id: string, note: string) => TodoPromise;
  /** Wakes the promise's agent now, whatever its date (a Not yet). */
  wakeNow: (id: string) => void;
  /** Marks the Inbox ask for this promise read, once it is answered. */
  clearNotice?: (id: string) => void;
  /** The clock. Defaults to the system clock. */
  now?: () => Date;
}

/** Asks and answers "was it kept?". */
export class TodoConfirm {
  private readonly now: () => Date;

  /**
   * Build the confirmations.
   *
   * @param deps - The table, the reopen, and the clock.
   */
  constructor(private readonly deps: TodoConfirmDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Mark a kept promise as waiting for its person's answer.
   *
   * @param id - The promise.
   * @returns Whether it is now waiting: false for one that is not kept, or was already answered.
   */
  ask(id: string): boolean {
    const row = this.deps.store.get(id);
    // Asked once per keep: a fresh keep after a Not yet asks again.
    if (
      !row ||
      row.state !== 'kept' ||
      (row.confirmState !== null && row.confirmState !== 'not-yet')
    ) {
      return false;
    }
    this.deps.store.update(id, { confirmState: 'asked' });
    return true;
  }

  /**
   * Take a person's answer: Yes confirms it, Not yet reopens it.
   *
   * @param actor - The person answering.
   * @param id - The promise.
   * @param answer - Yes or Not yet.
   * @throws {TodoPromiseError} `NOT_FOUND`, or `NOTHING_TO_CHANGE` when no answer is waiting.
   */
  answer(actor: TodoPromiseActor, id: string, answer: TodoConfirmAnswer): TodoPromise {
    const row = this.deps.store.get(id);
    if (!row) throw new TodoPromiseError('NOT_FOUND', 'No promise has that id.');
    const closed = row.closedAt ? Date.parse(row.closedAt) : NaN;
    if (
      row.state !== 'kept' ||
      row.confirmState !== 'asked' ||
      !(this.now().getTime() - closed < TODO_CONFIRM_WINDOW_MS)
    ) {
      throw new TodoPromiseError('NOTHING_TO_CHANGE', 'Nothing is waiting for an answer there.');
    }
    if (answer === 'not-yet') {
      // Owed again, and news to its agent whatever its date: the reopen keeps the timers quiet (a
      // wake is marked as already come), then the agent is woken once, now, and its grace runs
      // from this wake, never a miss on the spot.
      const at = this.now().toISOString();
      this.deps.store.update(id, { dueNotifiedAt: at, checkinNotifiedAt: null });
      this.deps.reopen(actor, id, 'Not yet, said the person.');
      const reopened = this.deps.store.update(id, {
        confirmState: 'not-yet',
        dueNotifiedAt: at,
        checkinNotifiedAt: null,
      })!;
      this.deps.wakeNow(id);
      this.deps.clearNotice?.(id);
      return toTodoPromise(reopened, this.now().getTime());
    }
    const updated = this.deps.store.update(id, { confirmState: 'confirmed' })!;
    this.deps.clearNotice?.(id);
    recordAudit({
      action: 'commitment.confirmed',
      operation: 'modify',
      target: { type: 'commitment', id, containerId: row.agentId },
      outcome: 'ok',
      change: [{ field: 'confirmState', before: 'asked', after: 'confirmed' }],
      summary: row.what,
      visibility: 'space',
    });
    return toTodoPromise(updated, this.now().getTime());
  }
}
