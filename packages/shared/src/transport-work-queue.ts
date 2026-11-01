/**
 * The work queue slice of the {@link Transport} port (DOR-3462): a person sees,
 * adds to, orders and pauses an agent's queue.
 *
 * @module shared/transport-work-queue
 */
import type {
  AddWorkItemRequest,
  SetWorkQueuesStoppedRequest,
  UpdateWorkQueueRequest,
  WorkItem,
  WorkQueue,
} from './work-queue-schemas.js';

/** The work queue methods every Transport implements. */
export interface WorkQueueTransport {
  /**
   * One agent's queue.
   *
   * @param agentId - The agent's Mesh id.
   */
  getWorkQueue(agentId: string): Promise<WorkQueue>;
  /**
   * Turn a queue on or off, or set its target or daily start cap.
   *
   * @param agentId - The agent's Mesh id.
   * @param body - What changes.
   */
  updateWorkQueue(agentId: string, body: UpdateWorkQueueRequest): Promise<WorkQueue>;
  /**
   * Stop every queue on this install, or lift the stop.
   *
   * @param stopped - Whether they are stopped.
   */
  setWorkQueuesStopped(stopped: boolean): Promise<SetWorkQueuesStoppedRequest>;
  /**
   * Set the order of what is waiting.
   *
   * @param agentId - The agent's Mesh id.
   * @param itemIds - The items, first to start first.
   */
  reorderWorkQueue(agentId: string, itemIds: string[]): Promise<WorkQueue>;
  /**
   * Add an item to the back of a queue.
   *
   * @param agentId - The agent's Mesh id.
   * @param body - The item.
   */
  addWorkItem(agentId: string, body: AddWorkItemRequest): Promise<WorkItem>;
  /**
   * Remove an item that is still waiting.
   *
   * @param agentId - The agent's Mesh id.
   * @param itemId - The item.
   */
  removeWorkItem(agentId: string, itemId: string): Promise<void>;
  /**
   * Queue an ended item again, which starts a new chat for it.
   *
   * @param agentId - The agent's Mesh id.
   * @param itemId - The item.
   */
  requeueWorkItem(agentId: string, itemId: string): Promise<WorkItem>;
}
