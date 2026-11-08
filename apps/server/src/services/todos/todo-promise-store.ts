/**
 * The `todos` table: what each agent promised, to whom, by when, and how
 * it ended (spec `heartbeats` §12). Since To-dos (DOR-3088) it also holds to-dos a person owns,
 * which this store never returns.
 *
 * Synchronous (better-sqlite3), like the other small stores: a list read is one
 * indexed query, and a write is one row.
 *
 * @module services/todos/todo-promise-store
 */
import {
  and,
  asc,
  todos,
  desc,
  eq,
  isNotNull,
  ne,
  sql,
  type TodoRow,
  type Db,
  type SQL,
} from '@dorkos/db';
import type { TodoState } from '@dorkos/shared/todo-promise-schemas';

/** How many rows one list read returns at most. Open ones are never cut. */
export const TODO_LIST_LIMIT = 500;

/** Filters a list read takes. Every one is optional. */
export interface TodoPromiseFilter {
  /** Only this agent's. */
  agentId?: string;
  /** Only to-dos in this state. */
  state?: TodoState;
  /** Only to-dos made to this account, agent or outsider. */
  to?: string;
}

/**
 * A row an agent owns: every to-do before to-dos, and every to-do assigned to an agent.
 * The promise readers (capabilities, routes, beats, due wakes) see only these; a to-do a person
 * owns is read through the to-dos surface instead (DOR-3088).
 */
export type AgentTodoRow = TodoRow & { agentId: string };

/** Only rows an agent owns. */
const AGENT_OWNED: SQL = isNotNull(todos.agentId);

/** The fields a change may touch. */
export type TodoPromisePatch = Partial<
  Pick<
    TodoRow,
    'state' | 'dueAt' | 'dueNotifiedAt' | 'closedAt' | 'note' | 'authority' | 'authorityMarks'
  >
>;

/** Reads and writes the `todos` table. */
export class TodoPromiseStore {
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
  insert(row: AgentTodoRow): AgentTodoRow {
    this.db.insert(todos).values(row).run();
    return row;
  }

  /**
   * One to-do by id.
   *
   * @param id - The to-do id.
   */
  get(id: string): AgentTodoRow | undefined {
    return this.db
      .select()
      .from(todos)
      .where(and(eq(todos.id, id), AGENT_OWNED))
      .get() as AgentTodoRow | undefined;
  }

  /**
   * Change a to-do.
   *
   * @param id - The to-do id.
   * @param patch - What changes.
   */
  update(id: string, patch: TodoPromisePatch): AgentTodoRow | undefined {
    this.db
      .update(todos)
      .set(patch)
      .where(and(eq(todos.id, id), AGENT_OWNED))
      .run();
    return this.get(id);
  }

  /**
   * To-dos matching the filter.
   *
   * Every open one, with no limit, soonest due first (no date last): an open
   * promise must never fall off a list because old closed ones crowded it out.
   * Then closed ones, most recently closed first, filling up to `limit` rows in all.
   *
   * @param filter - Which ones.
   * @param limit - How many rows in all, at most; open ones are never cut.
   */
  list(filter: TodoPromiseFilter = {}, limit = TODO_LIST_LIMIT): AgentTodoRow[] {
    const shared = [
      AGENT_OWNED,
      filter.agentId ? eq(todos.agentId, filter.agentId) : undefined,
      filter.to ? eq(todos.toAccount, filter.to) : undefined,
    ].filter((c) => c !== undefined);
    const wantOpen = filter.state === undefined || filter.state === 'open';
    const open = wantOpen
      ? this.db
          .select()
          .from(todos)
          .where(and(eq(todos.state, 'open'), ...shared))
          .orderBy(sql`${todos.dueAt} IS NULL`, asc(todos.dueAt), desc(todos.createdAt))
          .all()
      : [];
    if (filter.state === 'open') return open as AgentTodoRow[];
    const room = Math.max(0, limit - open.length);
    if (room === 0) return open as AgentTodoRow[];
    const closed = this.db
      .select()
      .from(todos)
      .where(and(filter.state ? eq(todos.state, filter.state) : ne(todos.state, 'open'), ...shared))
      .orderBy(desc(todos.closedAt), desc(todos.id))
      .limit(room)
      .all();
    return [...open, ...closed] as AgentTodoRow[];
  }

  /** Every open to-do that has a due date: what the due timers are built from. */
  openWithDueDate(): AgentTodoRow[] {
    return this.db
      .select()
      .from(todos)
      .where(and(eq(todos.state, 'open'), isNotNull(todos.dueAt), AGENT_OWNED))
      .all() as AgentTodoRow[];
  }
}
