/**
 * The loop that starts an agent's next item when it has a free slot (DOR-3462).
 *
 * A pass does three things: settle items whose chat ended, stop at any machine
 * limit, then start at most one item. One start per pass, because the load
 * average lags: eight chats started in one breath would all pass the same check.
 * Passes run on every turn end and on a timer, and the timer is how a queue
 * resumes when a limit clears, since nothing announces that.
 *
 * ## Never twice
 *
 * An item is claimed in the database before anything launches, and only a start
 * the launch path says did not happen hands it back. A launch that threw may have
 * started, so it ends the item instead. After a restart nothing is known about
 * the chats the old process ran, so taking leadership ends every active item as
 * `interrupted`, and only a person's explicit requeue runs one again.
 *
 * ## No new power
 *
 * The runner decides when, never what an agent may do. The start itself is
 * `session_start`'s own path, reached through {@link WorkQueueRunnerDeps.startChat},
 * which reads the agent's level and whether it is paused at that moment, never at
 * the moment the item was added. An agent whose permissions do not let it start a
 * chat unasked right now is held rather than asked for.
 *
 * ## A runaway stops itself
 *
 * A queue is off until a person turns it on. Each has a daily start cap a person
 * sets, one person-only stop halts them all, and the machine's chat cap holds
 * across queues and every other start. A chat that raises an approval card keeps
 * its slot while it waits, so nothing starts behind it past the target.
 *
 * @module services/work-queue/work-queue-runner
 */
import type { AgentWorkItemRow } from '@dorkos/db';
import type { WorkItemOutcome, WorkQueueHold } from '@dorkos/shared/work-queue-schemas';
import { logError, logger } from '../../lib/logger.js';
import type { WorkQueueStore } from './work-queue-store.js';

/** What a chat is doing, as a pass needs to know it. */
export type ChatState =
  { kind: 'live' } | { kind: 'ended'; outcome: WorkItemOutcome; note?: string };

/** What trying to start a chat came to. */
export type StartResult =
  | { kind: 'started'; sessionId: string; accountId: string | null }
  /** Nothing started, so the item stays in line. */
  | { kind: 'held'; hold: WorkQueueHold }
  /** Nothing started and trying again will not help. */
  | { kind: 'refused'; message: string };

/** The agent a queue belongs to. */
export interface QueueAgent {
  agentId: string;
  agentPath: string;
  label: string;
}

/** What the runner reaches the rest of the server through. */
export interface WorkQueueRunnerDeps {
  /** The tables. */
  store: WorkQueueStore;
  /** Whether this process is the one that runs queues; refreshes it if so. */
  isLeader(): boolean;
  /** The machine limit in force, or null. */
  machineHold(): Promise<WorkQueueHold | null>;
  /** Whether every slot under the chat cap is taken. */
  chatCapFull(): boolean;
  /** The agent with this id, or undefined when it is not registered. */
  agentOf(agentId: string): QueueAgent | undefined;
  /** Whether this agent may start a chat right now without anyone being asked. */
  mayStartChat(agent: QueueAgent): Promise<boolean>;
  /** Start the item's chat. May throw, and then it may have started. */
  startChat(agent: QueueAgent, item: AgentWorkItemRow): Promise<StartResult>;
  /** What a started chat is doing. */
  chatState(item: AgentWorkItemRow): Promise<ChatState>;
  /** The time now. */
  now(): Date;
}

/** Starts each agent's next item when it has room. */
export class WorkQueueRunner {
  private passing = false;
  private again = false;
  private led = false;
  /** Why each agent's queue did not start, from the last pass that looked. */
  private readonly holds = new Map<string, WorkQueueHold>();

  /**
   * Build a runner.
   *
   * @param deps - What it reaches the rest of the server through.
   */
  constructor(private readonly deps: WorkQueueRunnerDeps) {}

  /**
   * What is stopping one agent's next start, or null.
   *
   * @param agentId - The agent.
   */
  holdOf(agentId: string): WorkQueueHold | null {
    return this.holds.get(agentId) ?? null;
  }

  /**
   * Run one pass. A pass asked for during another runs right after it, so a turn
   * end is never lost, and two never overlap.
   */
  async pass(): Promise<void> {
    if (this.passing) {
      this.again = true;
      return;
    }
    this.passing = true;
    try {
      do {
        this.again = false;
        await this.runPass();
      } while (this.again);
    } catch (err) {
      logger.warn('[work-queue] a pass failed', logError(err));
    } finally {
      this.passing = false;
    }
  }

  private async runPass(): Promise<void> {
    const leader = this.deps.isLeader();
    if (!leader) {
      this.led = false;
      this.holds.clear();
      return;
    }
    if (!this.led) {
      this.led = true;
      this.endOrphans();
    }
    await this.settleEnded();
    await this.startNext();
  }

  /** Taking over: nothing is known about the chats anyone ran before now. */
  private endOrphans(): void {
    const endedAt = this.deps.now().toISOString();
    for (const item of this.deps.store.active()) {
      this.deps.store.markEnded(item.id, {
        outcome: 'interrupted',
        note: 'DorkOS restarted while this ran.',
        endedAt,
      });
    }
  }

  private async settleEnded(): Promise<void> {
    for (const item of this.deps.store.running()) {
      const state = await this.deps.chatState(item);
      if (state.kind === 'live') continue;
      this.deps.store.markEnded(item.id, {
        outcome: state.outcome,
        note: state.note ?? null,
        endedAt: this.deps.now().toISOString(),
      });
    }
  }

  private async startNext(): Promise<void> {
    this.holds.clear();
    const queues = this.deps.store
      .queuesWithWork()
      .filter((queue) => queue.settings.enabled && queue.active < queue.settings.target);
    if (queues.length === 0) return;

    const everyone = this.deps.store.allStopped()
      ? 'stopped'
      : ((await this.deps.machineHold()) ?? (this.deps.chatCapFull() ? 'chat-cap' : null));
    if (everyone) {
      for (const queue of queues) this.holds.set(queue.agentId, everyone);
      return;
    }

    for (const queue of queues) {
      if (await this.startFor(queue.agentId, queue.settings.dailyStartCap)) return;
    }
  }

  /** Try one agent's next item. Returns whether a chat may have started. */
  private async startFor(agentId: string, dailyStartCap: number): Promise<boolean> {
    const day = this.deps.now().toISOString().slice(0, 10);
    if (this.deps.store.startsOn(agentId, day) >= dailyStartCap) {
      this.holds.set(agentId, 'daily-cap');
      return false;
    }
    const agent = this.deps.agentOf(agentId);
    if (!agent) {
      this.holds.set(agentId, 'agent-missing');
      return false;
    }
    if (!(await this.deps.mayStartChat(agent))) {
      this.holds.set(agentId, 'permission');
      return false;
    }
    const item = this.deps.store.next(agentId);
    if (!item || !this.deps.store.claim(item, day)) return false;

    let result: StartResult;
    try {
      result = await this.deps.startChat(agent, item);
    } catch (err) {
      // It may have started, so it never goes back in line.
      logger.warn('[work-queue] starting an item threw', { itemId: item.id, ...logError(err) });
      this.deps.store.markEnded(item.id, {
        outcome: 'failed',
        note: err instanceof Error ? err.message.slice(0, 500) : 'The chat could not be started.',
        endedAt: this.deps.now().toISOString(),
      });
      return true;
    }
    switch (result.kind) {
      case 'started':
        this.deps.store.markRunning(item.id, {
          sessionId: result.sessionId,
          accountId: result.accountId,
          startedAt: this.deps.now().toISOString(),
        });
        return true;
      case 'held':
        this.deps.store.release(item, day);
        this.holds.set(agentId, result.hold);
        return false;
      case 'refused':
        this.deps.store.refundStart(item, day);
        this.deps.store.markEnded(item.id, {
          outcome: 'failed',
          note: result.message.slice(0, 500),
          endedAt: this.deps.now().toISOString(),
        });
        return false;
    }
  }
}
