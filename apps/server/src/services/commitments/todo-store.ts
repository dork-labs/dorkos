/**
 * The `commitments` table read as to-dos (DOR-3088): every row, whoever owns it. The promise
 * readers use `CommitmentStore`, which only ever sees rows an agent owns.
 *
 * @module services/commitments/todo-store
 */
import { commitments, eq, type CommitmentRow, type Db } from '@dorkos/db';

/** The columns a to-do change may write. Who assigned it and when it was made never change. */
export type TodoPatch = Partial<
  Pick<
    CommitmentRow,
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
  insert(row: CommitmentRow): CommitmentRow {
    this.db.insert(commitments).values(row).run();
    return row;
  }

  /**
   * One to-do by id, whoever owns it.
   *
   * @param id - The to-do id.
   */
  get(id: string): CommitmentRow | undefined {
    return this.db.select().from(commitments).where(eq(commitments.id, id)).get();
  }

  /**
   * Change a to-do.
   *
   * @param id - The to-do id.
   * @param patch - What changes.
   */
  update(id: string, patch: TodoPatch): CommitmentRow | undefined {
    this.db.update(commitments).set(patch).where(eq(commitments.id, id)).run();
    return this.get(id);
  }
}
