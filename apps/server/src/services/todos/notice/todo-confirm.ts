/**
 * "Kept" asks the person it was promised to (DOR-3034). An agent signing off its own promise is
 * not the same as the person agreeing it happened, so a promise to a person, marked kept by its
 * agent, waits for one answer: **Yes** confirms it, **Not yet** reopens it and wakes the agent. Nobody has to answer:
 * after a day with no answer the app reads it as "kept · unconfirmed", so the person is given no
 * chore. Promises between agents are never asked.
 *
 * @module services/todos/notice/todo-confirm
 */
import type { TodoPromise } from '@dorkos/shared/todo-promise-schemas';
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
    if (row.state !== 'kept' || row.confirmState !== 'asked') {
      throw new TodoPromiseError('NOTHING_TO_CHANGE', 'Nothing is waiting for an answer there.');
    }
    this.deps.clearNotice?.(id);
    if (answer === 'not-yet') {
      // Owed again, and news to its agent even past the date: with its old wakes forgotten, the
      // reopen wakes it to start now, and its grace runs from that wake, never a miss on the spot.
      this.deps.store.update(id, { dueNotifiedAt: null, checkinNotifiedAt: null });
      this.deps.reopen(actor, id, 'Not yet, said the person.');
      const reopened = this.deps.store.update(id, { confirmState: 'not-yet' })!;
      return toTodoPromise(reopened, this.now().getTime());
    }
    const updated = this.deps.store.update(id, { confirmState: 'confirmed' })!;
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
