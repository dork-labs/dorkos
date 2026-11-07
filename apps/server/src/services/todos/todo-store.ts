/**
 * The `todos` table read as to-dos (DOR-3088): every row, whoever owns it. The promise
 * readers use `TodoPromiseStore`, which only ever sees rows an agent owns.
 *
 * @module services/todos/todo-store
 */
import { ulid } from 'ulidx';
import { and, todos, eq, todoPersonAsks, type TodoRow, type Db } from '@dorkos/db';

/** The columns a to-do change may write. Who assigned it and when it was made never change. */
export type TodoPatch = Partial<
  Pick<
    TodoRow,
    | 'agentId'
    | 'ownerAccount'
    | 'what'
    | 'dueAt'
    | 'dueNotifiedAt'
    | 'state'
    | 'closedAt'
    | 'note'
    | 'notes'
    | 'rank'
    | 'titleFromSource'
    | 'authority'
    | 'authorityMarks'
    | 'chainDepth'
    | 'chainAgents'
  >
>;

/** Reads and writes to-dos. */
export class TodoStore {
  /**
   * Build a store over the database.
   *
   * @param db - The DorkOS database.
   */
  constructor(private readonly db: Db) {}

  /**
   * Write a new to-do.
   *
   * @param row - The full row.
   */
  insert(row: TodoRow): TodoRow {
    this.db.insert(todos).values(row).run();
    return row;
  }

  /**
   * One to-do by id, whoever owns it.
   *
   * @param id - The to-do id.
   */
  get(id: string): TodoRow | undefined {
    return this.db.select().from(todos).where(eq(todos.id, id)).get();
  }

  /** Every row, whoever owns it: what a list view filters. */
  all(): TodoRow[] {
    return this.db.select().from(todos).all();
  }

  /**
   * How many to-dos an agent has handed people on a UTC day: what its 5-a-day cap counts. Read
   * from the hand-over ledger, so a to-do moved away afterwards still counts.
   *
   * @param agentId - The agent.
   * @param day - The UTC day (`YYYY-MM-DD`).
   */
  countPersonAsks(agentId: string, day: string): number {
    return this.db
      .select({ id: todoPersonAsks.id })
      .from(todoPersonAsks)
      .where(and(eq(todoPersonAsks.agentId, agentId), eq(todoPersonAsks.day, day)))
      .all().length;
  }

  /**
   * Record that an agent handed a person a to-do.
   *
   * @param agentId - The agent.
   * @param todoId - The to-do.
   * @param at - When (ISO 8601).
   */
  recordPersonAsk(agentId: string, todoId: string, at: string): void {
    this.db
      .insert(todoPersonAsks)
      .values({ id: ulid(), agentId, todoId, day: at.slice(0, 10), createdAt: at })
      .run();
  }

  /**
   * Change a to-do.
   *
   * @param id - The to-do id.
   * @param patch - What changes.
   */
  update(id: string, patch: TodoPatch): TodoRow | undefined {
    this.db.update(todos).set(patch).where(eq(todos.id, id)).run();
    return this.get(id);
  }
}
