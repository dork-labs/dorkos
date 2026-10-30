/**
 * The work queue tables (DOR-3462). Synchronous (better-sqlite3), like the other
 * small stores, which is what makes {@link WorkQueueStore.claim} safe: the claim
 * is one statement, so two passes cannot both win it.
 *
 * @module services/work-queue/work-queue-store
 */
import {
  agentWorkItems,
  agentWorkQueues,
  and,
  asc,
  desc,
  eq,
  inArray,
  sql,
  workQueueControl,
  type AgentWorkItemRow,
  type AgentWorkQueueRow,
  type Db,
} from '@dorkos/db';

/** The defaults of an agent with no queue row: off. */
const DEFAULT_SETTINGS = {
  enabled: false,
  target: 1,
  dailyStartCap: 20,
  startsDay: null,
  startsToday: 0,
} as const;

/** The one row of the control table. */
const CONTROL_ID = 1;

/** How many ended items a read returns per agent. */
const RECENT_LIMIT = 20;

/** The states of an item a chat holds, or is about to. */
const ACTIVE = ['starting', 'running'] as const;

/** How one queue runs. */
export type QueueSettings = Pick<
  AgentWorkQueueRow,
  'enabled' | 'target' | 'dailyStartCap' | 'startsDay' | 'startsToday'
>;

/** What a person may change about a queue. */
export type QueueSettingsPatch = Partial<
  Pick<AgentWorkQueueRow, 'enabled' | 'target' | 'dailyStartCap'>
>;

/** The fields an item is created with. */
export type NewWorkItem = Pick<
  AgentWorkItemRow,
  'id' | 'agentId' | 'title' | 'prompt' | 'cwd' | 'addedBy' | 'createdAt'
>;

/** Reads and writes the work queue tables. */
export class WorkQueueStore {
  /**
   * Build a store over the database.
   *
   * @param db - The DorkOS database.
   */
  constructor(private readonly db: Db) {}

  /**
   * How one agent's queue runs, or the defaults.
   *
   * @param agentId - The agent.
   */
  settings(agentId: string): QueueSettings {
    const row = this.db
      .select()
      .from(agentWorkQueues)
      .where(eq(agentWorkQueues.agentId, agentId))
      .get();
    return row ?? DEFAULT_SETTINGS;
  }

  /**
   * How many chats one agent's queue started on a day.
   *
   * @param agentId - The agent.
   * @param day - The UTC day, `YYYY-MM-DD`.
   */
  startsOn(agentId: string, day: string): number {
    const { startsDay, startsToday } = this.settings(agentId);
    return startsDay === day ? startsToday : 0;
  }

  /** Whether a person stopped every queue on this install. */
  allStopped(): boolean {
    const row = this.db
      .select()
      .from(workQueueControl)
      .where(eq(workQueueControl.id, CONTROL_ID))
      .get();
    return row?.stopped ?? false;
  }

  /**
   * Stop every queue on this install, or lift the stop.
   *
   * @param stopped - Whether they are stopped.
   * @param now - The time to stamp it with.
   */
  setAllStopped(stopped: boolean, now: string): void {
    this.db
      .insert(workQueueControl)
      .values({ id: CONTROL_ID, stopped, updatedAt: now })
      .onConflictDoUpdate({ target: workQueueControl.id, set: { stopped, updatedAt: now } })
      .run();
  }

  /**
   * Change how one agent's queue runs.
   *
   * @param agentId - The agent.
   * @param patch - What changes.
   * @param now - The time to stamp it with.
   */
  updateSettings(agentId: string, patch: QueueSettingsPatch, now: string): void {
    this.db
      .insert(agentWorkQueues)
      .values({ agentId, ...this.settings(agentId), ...patch, updatedAt: now })
      .onConflictDoUpdate({
        target: agentWorkQueues.agentId,
        set: { ...patch, updatedAt: now },
      })
      .run();
  }

  /**
   * Put an item at the back of its queue.
   *
   * @param item - The item.
   */
  add(item: NewWorkItem): AgentWorkItemRow {
    const row: AgentWorkItemRow = {
      ...item,
      position: this.nextPosition(item.agentId),
      state: 'queued',
      outcome: null,
      note: null,
      sessionId: null,
      accountId: null,
      startedAt: null,
      endedAt: null,
    };
    this.db.insert(agentWorkItems).values(row).run();
    return row;
  }

  /**
   * One item by id.
   *
   * @param id - The item.
   */
  get(id: string): AgentWorkItemRow | undefined {
    return this.db.select().from(agentWorkItems).where(eq(agentWorkItems.id, id)).get();
  }

  /**
   * One agent's waiting items in order, then its active ones.
   *
   * @param agentId - The agent.
   */
  open(agentId: string): AgentWorkItemRow[] {
    return this.db
      .select()
      .from(agentWorkItems)
      .where(
        and(
          eq(agentWorkItems.agentId, agentId),
          inArray(agentWorkItems.state, ['queued', ...ACTIVE])
        )
      )
      .orderBy(asc(agentWorkItems.position))
      .all();
  }

  /**
   * One agent's most recently ended items.
   *
   * @param agentId - The agent.
   */
  recent(agentId: string): AgentWorkItemRow[] {
    return this.db
      .select()
      .from(agentWorkItems)
      .where(and(eq(agentWorkItems.agentId, agentId), eq(agentWorkItems.state, 'ended')))
      .orderBy(desc(agentWorkItems.endedAt))
      .limit(RECENT_LIMIT)
      .all();
  }

  /**
   * How many items wait in one agent's queue.
   *
   * @param agentId - The agent.
   */
  countQueued(agentId: string): number {
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(agentWorkItems)
      .where(and(eq(agentWorkItems.agentId, agentId), eq(agentWorkItems.state, 'queued')))
      .get();
    return row?.count ?? 0;
  }

  /**
   * Every agent with something waiting, longest-waiting first, with how many of
   * its chats are active.
   */
  queuesWithWork(): { agentId: string; active: number; settings: QueueSettings }[] {
    const rows = this.db
      .select({ agentId: agentWorkItems.agentId, oldest: sql<string>`min(created_at)` })
      .from(agentWorkItems)
      .where(eq(agentWorkItems.state, 'queued'))
      .groupBy(agentWorkItems.agentId)
      .orderBy(sql`min(created_at)`)
      .all();
    return rows.map(({ agentId }) => ({
      agentId,
      active: this.countActive(agentId),
      settings: this.settings(agentId),
    }));
  }

  /**
   * The first waiting item of one agent's queue.
   *
   * @param agentId - The agent.
   */
  next(agentId: string): AgentWorkItemRow | undefined {
    return this.db
      .select()
      .from(agentWorkItems)
      .where(and(eq(agentWorkItems.agentId, agentId), eq(agentWorkItems.state, 'queued')))
      .orderBy(asc(agentWorkItems.position))
      .limit(1)
      .get();
  }

  /**
   * Take an item to start it, and count the start against its agent's day, in one
   * transaction. Exactly one caller wins, and a crash after this has spent a start
   * rather than given one back.
   *
   * @param item - The item.
   * @param day - The UTC day, `YYYY-MM-DD`.
   * @returns Whether this caller took it.
   */
  claim(item: Pick<AgentWorkItemRow, 'id' | 'agentId'>, day: string): boolean {
    return this.db.transaction((tx) => {
      const result = tx
        .update(agentWorkItems)
        .set({ state: 'starting' })
        .where(and(eq(agentWorkItems.id, item.id), eq(agentWorkItems.state, 'queued')))
        .run();
      if (result.changes !== 1) return false;
      tx.update(agentWorkQueues)
        .set({
          startsDay: day,
          startsToday: sql`CASE WHEN ${agentWorkQueues.startsDay} = ${day} THEN ${agentWorkQueues.startsToday} + 1 ELSE 1 END`,
        })
        .where(eq(agentWorkQueues.agentId, item.agentId))
        .run();
      return true;
    });
  }

  /**
   * Give back a start that never happened.
   *
   * @param item - The item.
   * @param day - The UTC day the claim counted it on.
   */
  refundStart(item: Pick<AgentWorkItemRow, 'agentId'>, day: string): void {
    this.db
      .update(agentWorkQueues)
      .set({ startsToday: sql`max(${agentWorkQueues.startsToday} - 1, 0)` })
      .where(and(eq(agentWorkQueues.agentId, item.agentId), eq(agentWorkQueues.startsDay, day)))
      .run();
  }

  /**
   * Hand a claimed item back, only when nothing was started for it.
   *
   * @param item - The item.
   * @param day - The UTC day the claim counted it on.
   */
  release(item: Pick<AgentWorkItemRow, 'id' | 'agentId'>, day: string): void {
    this.db
      .update(agentWorkItems)
      .set({ state: 'queued' })
      .where(and(eq(agentWorkItems.id, item.id), eq(agentWorkItems.state, 'starting')))
      .run();
    this.refundStart(item, day);
  }

  /**
   * Record the chat a claimed item started.
   *
   * @param id - The item.
   * @param chat - The chat, its account, and when it started.
   */
  markRunning(
    id: string,
    chat: { sessionId: string; accountId: string | null; startedAt: string }
  ): void {
    this.db
      .update(agentWorkItems)
      .set({ state: 'running', ...chat })
      .where(eq(agentWorkItems.id, id))
      .run();
  }

  /**
   * End an item.
   *
   * @param id - The item.
   * @param end - How it ended.
   */
  markEnded(
    id: string,
    end: { outcome: NonNullable<AgentWorkItemRow['outcome']>; note: string | null; endedAt: string }
  ): void {
    this.db
      .update(agentWorkItems)
      .set({ state: 'ended', ...end })
      .where(eq(agentWorkItems.id, id))
      .run();
  }

  /**
   * Every item a chat holds right now, on every agent.
   */
  running(): AgentWorkItemRow[] {
    return this.db.select().from(agentWorkItems).where(eq(agentWorkItems.state, 'running')).all();
  }

  /**
   * Every item a chat holds or was about to, on every agent.
   */
  active(): AgentWorkItemRow[] {
    return this.db
      .select()
      .from(agentWorkItems)
      .where(inArray(agentWorkItems.state, [...ACTIVE]))
      .all();
  }

  /**
   * Follow a chat whose id changed.
   *
   * @param from - The old id.
   * @param to - The new id.
   */
  rekey(from: string, to: string): void {
    this.db
      .update(agentWorkItems)
      .set({ sessionId: to })
      .where(and(eq(agentWorkItems.sessionId, from), eq(agentWorkItems.state, 'running')))
      .run();
  }

  /**
   * Put an ended item at the back of its queue again. Only a person's explicit
   * ask reaches this: a re-queued item starts a new chat.
   *
   * @param id - The item.
   * @returns Whether it moved.
   */
  requeue(id: string): boolean {
    const item = this.get(id);
    if (!item) return false;
    const result = this.db
      .update(agentWorkItems)
      .set({
        state: 'queued',
        position: this.nextPosition(item.agentId),
        outcome: null,
        note: null,
        sessionId: null,
        accountId: null,
        startedAt: null,
        endedAt: null,
      })
      .where(and(eq(agentWorkItems.id, id), eq(agentWorkItems.state, 'ended')))
      .run();
    return result.changes === 1;
  }

  /**
   * Remove an item that is still waiting.
   *
   * @param id - The item.
   * @returns Whether it was removed.
   */
  remove(id: string): boolean {
    const result = this.db
      .delete(agentWorkItems)
      .where(and(eq(agentWorkItems.id, id), eq(agentWorkItems.state, 'queued')))
      .run();
    return result.changes === 1;
  }

  /**
   * Set the order of the waiting items, leaving out any that started meanwhile.
   *
   * @param agentId - The agent.
   * @param itemIds - The items, first to start first.
   */
  reorder(agentId: string, itemIds: readonly string[]): void {
    this.db.transaction((tx) => {
      itemIds.forEach((id, position) => {
        tx.update(agentWorkItems)
          .set({ position })
          .where(
            and(
              eq(agentWorkItems.id, id),
              eq(agentWorkItems.agentId, agentId),
              eq(agentWorkItems.state, 'queued')
            )
          )
          .run();
      });
    });
  }

  private countActive(agentId: string): number {
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(agentWorkItems)
      .where(and(eq(agentWorkItems.agentId, agentId), inArray(agentWorkItems.state, [...ACTIVE])))
      .get();
    return row?.count ?? 0;
  }

  private nextPosition(agentId: string): number {
    const row = this.db
      .select({ top: sql<number | null>`max(position)` })
      .from(agentWorkItems)
      .where(eq(agentWorkItems.agentId, agentId))
      .get();
    return (row?.top ?? -1) + 1;
  }
}
