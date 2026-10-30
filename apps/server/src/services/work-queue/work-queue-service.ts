/**
 * The rules of an agent's work queue (DOR-3462): who may change what.
 *
 * An agent works on its own queue only, as `session_start` starts chats only as
 * the caller: it may add and remove items, and read the list. Everything about how
 * a queue runs is a person's: turning it on (off by default, and off is how it is
 * paused), its target, its daily start cap, the order, queueing an ended item
 * again, and the stop on every queue. No agent tool reaches those methods.
 *
 * @module services/work-queue/work-queue-service
 */
import path from 'node:path';
import { ulid } from 'ulidx';
import type { AgentWorkItemRow } from '@dorkos/db';
import {
  WORK_QUEUE_MAX_QUEUED,
  type AddWorkItemRequest,
  type UpdateWorkQueueRequest,
  type WorkItem,
  type WorkQueue,
  type WorkQueueHold,
} from '@dorkos/shared/work-queue-schemas';
import type { WorkQueueStore } from './work-queue-store.js';

/** Who is acting on a queue. */
export type WorkQueueActor = { kind: 'person' } | { kind: 'agent'; agentId: string };

/** A stable refusal code. */
export type WorkQueueErrorCode =
  'NOT_FOUND' | 'NOT_YOURS' | 'NOT_QUEUED' | 'NOT_ENDED' | 'FULL' | 'BAD_CWD';

/** A refusal, in a sentence the caller can show. */
export class WorkQueueError extends Error {
  /**
   * Build a refusal.
   *
   * @param code - The stable code.
   * @param message - The sentence.
   */
  constructor(
    readonly code: WorkQueueErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'WorkQueueError';
  }
}

/** What the service needs. */
export interface WorkQueueServiceDeps {
  /** The tables. */
  store: WorkQueueStore;
  /** What is stopping one agent's next start, or null. */
  holdOf(agentId: string): WorkQueueHold | null;
  /** Ask for a pass soon, because something changed. */
  wake(): void;
  /** The time now. */
  now?: () => Date;
}

/** The wire form of an item row. */
function toWorkItem(row: AgentWorkItemRow): WorkItem {
  const { position: _position, ...item } = row;
  return item;
}

/** Reads and changes agents' work queues. */
export class WorkQueueService {
  private readonly now: () => Date;

  /**
   * Build the service.
   *
   * @param deps - What it needs.
   */
  constructor(private readonly deps: WorkQueueServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * One agent's queue.
   *
   * @param agentId - The agent.
   */
  read(agentId: string): WorkQueue {
    const { enabled, target, dailyStartCap } = this.deps.store.settings(agentId);
    return {
      agentId,
      enabled,
      target,
      dailyStartCap,
      startsToday: this.deps.store.startsOn(agentId, this.now().toISOString().slice(0, 10)),
      allStopped: this.deps.store.allStopped(),
      hold: this.deps.holdOf(agentId),
      items: this.deps.store.open(agentId).map(toWorkItem),
      recent: this.deps.store.recent(agentId).map(toWorkItem),
    };
  }

  /**
   * Put an item at the back of an agent's queue.
   *
   * @param actor - Who is adding it.
   * @param agentId - The agent whose queue it joins.
   * @param body - The item.
   */
  add(actor: WorkQueueActor, agentId: string, body: AddWorkItemRequest): WorkItem {
    this.assertOwn(actor, agentId);
    if (body.cwd !== undefined && !path.isAbsolute(body.cwd)) {
      throw new WorkQueueError('BAD_CWD', `The folder must be an absolute path: ${body.cwd}`);
    }
    if (this.deps.store.countQueued(agentId) >= WORK_QUEUE_MAX_QUEUED) {
      throw new WorkQueueError(
        'FULL',
        `This queue already has ${WORK_QUEUE_MAX_QUEUED} items waiting.`
      );
    }
    const row = this.deps.store.add({
      id: ulid(),
      agentId,
      title: body.title,
      prompt: body.prompt,
      cwd: body.cwd ?? null,
      addedBy: actor.kind,
      createdAt: this.now().toISOString(),
    });
    this.deps.wake();
    return toWorkItem(row);
  }

  /**
   * Remove an item that is still waiting. A running one is its chat's to end.
   *
   * @param actor - Who is removing it.
   * @param id - The item.
   */
  remove(actor: WorkQueueActor, id: string): void {
    const item = this.deps.store.get(id);
    if (!item) throw new WorkQueueError('NOT_FOUND', 'No item in a work queue has that id.');
    this.assertOwn(actor, item.agentId);
    if (!this.deps.store.remove(id)) {
      throw new WorkQueueError('NOT_QUEUED', 'That item has already started.');
    }
  }

  /**
   * Turn an agent's queue on or off, or set its target or daily start cap. A
   * person's call, only ever reached from the person's route.
   *
   * @param agentId - The agent.
   * @param body - What changes.
   */
  update(agentId: string, body: UpdateWorkQueueRequest): WorkQueue {
    this.deps.store.updateSettings(
      agentId,
      {
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.target !== undefined ? { target: body.target } : {}),
        ...(body.dailyStartCap !== undefined ? { dailyStartCap: body.dailyStartCap } : {}),
      },
      this.now().toISOString()
    );
    this.deps.wake();
    return this.read(agentId);
  }

  /**
   * Stop every queue on this install, or lift the stop. A person's call. Chats
   * already running keep going; nothing new starts.
   *
   * @param stopped - Whether they are stopped.
   */
  setAllStopped(stopped: boolean): void {
    this.deps.store.setAllStopped(stopped, this.now().toISOString());
    this.deps.wake();
  }

  /**
   * Set the order of an agent's waiting items. One that started meanwhile is left
   * where it is.
   *
   * @param agentId - The agent.
   * @param itemIds - The items, first to start first.
   */
  reorder(agentId: string, itemIds: readonly string[]): WorkQueue {
    this.deps.store.reorder(agentId, itemIds);
    return this.read(agentId);
  }

  /**
   * Put an ended item at the back of its queue, which starts a new chat for it.
   *
   * @param id - The item.
   */
  requeue(id: string): WorkItem {
    const item = this.deps.store.get(id);
    if (!item) throw new WorkQueueError('NOT_FOUND', 'No item in a work queue has that id.');
    if (!this.deps.store.requeue(id)) {
      throw new WorkQueueError('NOT_ENDED', 'That item has not ended.');
    }
    this.deps.wake();
    return toWorkItem(this.deps.store.get(id) as AgentWorkItemRow);
  }

  private assertOwn(actor: WorkQueueActor, agentId: string): void {
    if (actor.kind === 'agent' && actor.agentId !== agentId) {
      throw new WorkQueueError('NOT_YOURS', 'An agent can change only its own queue.');
    }
  }
}
