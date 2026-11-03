/**
 * The `commitments` table: what each agent promised, to whom, by when, and how
 * it ended (spec `heartbeats` §12). Since To-dos (DOR-3088) it also holds to-dos a person owns,
 * which this store never returns.
 *
 * Synchronous (better-sqlite3), like the other small stores: a list read is one
 * indexed query, and a write is one row.
 *
 * @module services/commitments/commitment-store
 */
import {
  and,
  asc,
  commitments,
  desc,
  eq,
  isNotNull,
  ne,
  sql,
  type CommitmentRow,
  type Db,
  type SQL,
} from '@dorkos/db';
import type { CommitmentState } from '@dorkos/shared/commitment-schemas';

/** How many rows one list read returns at most. Open ones are never cut. */
export const COMMITMENT_LIST_LIMIT = 500;

/** Filters a list read takes. Every one is optional. */
export interface CommitmentFilter {
  /** Only this agent's. */
  agentId?: string;
  /** Only commitments in this state. */
  state?: CommitmentState;
  /** Only commitments made to this account, agent or outsider. */
  to?: string;
}

/**
 * A row an agent owns: every commitment before to-dos, and every to-do assigned to an agent.
 * The promise readers (capabilities, routes, beats, due wakes) see only these; a to-do a person
 * owns is read through the to-dos surface instead (DOR-3088).
 */
export type AgentCommitmentRow = CommitmentRow & { agentId: string };

/** Only rows an agent owns. */
const AGENT_OWNED: SQL = isNotNull(commitments.agentId);

/** The fields a change may touch. */
export type CommitmentPatch = Partial<
  Pick<
    CommitmentRow,
    'state' | 'dueAt' | 'dueNotifiedAt' | 'closedAt' | 'note' | 'authority' | 'authorityMarks'
  >
>;

/** Reads and writes the `commitments` table. */
export class CommitmentStore {
  /**
   * Build a store over the database.
   *
   * @param db - The DorkOS database.
   */
  constructor(private readonly db: Db) {}

  /**
   * Write a new commitment.
   *
   * @param row - The full row.
   */
  insert(row: AgentCommitmentRow): AgentCommitmentRow {
    this.db.insert(commitments).values(row).run();
    return row;
  }

  /**
   * One commitment by id.
   *
   * @param id - The commitment id.
   */
  get(id: string): AgentCommitmentRow | undefined {
    return this.db
      .select()
      .from(commitments)
      .where(and(eq(commitments.id, id), AGENT_OWNED))
      .get() as AgentCommitmentRow | undefined;
  }

  /**
   * Change a commitment.
   *
   * @param id - The commitment id.
   * @param patch - What changes.
   */
  update(id: string, patch: CommitmentPatch): AgentCommitmentRow | undefined {
    this.db
      .update(commitments)
      .set(patch)
      .where(and(eq(commitments.id, id), AGENT_OWNED))
      .run();
    return this.get(id);
  }

  /**
   * Commitments matching the filter.
   *
   * Every open one, with no limit, soonest due first (no date last): an open
   * promise must never fall off a list because old closed ones crowded it out.
   * Then closed ones, most recently closed first, filling up to `limit` rows in all.
   *
   * @param filter - Which ones.
   * @param limit - How many rows in all, at most; open ones are never cut.
   */
  list(filter: CommitmentFilter = {}, limit = COMMITMENT_LIST_LIMIT): AgentCommitmentRow[] {
    const shared = [
      AGENT_OWNED,
      filter.agentId ? eq(commitments.agentId, filter.agentId) : undefined,
      filter.to ? eq(commitments.toAccount, filter.to) : undefined,
    ].filter((c) => c !== undefined);
    const wantOpen = filter.state === undefined || filter.state === 'open';
    const open = wantOpen
      ? this.db
          .select()
          .from(commitments)
          .where(and(eq(commitments.state, 'open'), ...shared))
          .orderBy(
            sql`${commitments.dueAt} IS NULL`,
            asc(commitments.dueAt),
            desc(commitments.createdAt)
          )
          .all()
      : [];
    if (filter.state === 'open') return open as AgentCommitmentRow[];
    const room = Math.max(0, limit - open.length);
    if (room === 0) return open as AgentCommitmentRow[];
    const closed = this.db
      .select()
      .from(commitments)
      .where(
        and(
          filter.state ? eq(commitments.state, filter.state) : ne(commitments.state, 'open'),
          ...shared
        )
      )
      .orderBy(desc(commitments.closedAt), desc(commitments.id))
      .limit(room)
      .all();
    return [...open, ...closed] as AgentCommitmentRow[];
  }

  /** Every open commitment that has a due date: what the due timers are built from. */
  openWithDueDate(): AgentCommitmentRow[] {
    return this.db
      .select()
      .from(commitments)
      .where(and(eq(commitments.state, 'open'), isNotNull(commitments.dueAt), AGENT_OWNED))
      .all() as AgentCommitmentRow[];
  }
}
