/**
 * Work queue Transport method factory (DOR-3462), through the generated API
 * client (DOR-5473).
 *
 * @module shared/lib/transport/work-queue-methods
 */
import type {
  AddWorkItemRequest,
  SetWorkQueuesStoppedRequest,
  UpdateWorkQueueRequest,
  WorkItem,
  WorkQueue,
} from '@dorkos/shared/work-queue-schemas';
import { createTransportApiClient } from './api-client';

/**
 * Create the work queue methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 */
export function createWorkQueueMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  // The document also lists each capability's 202 approval answer, which a
  // person's own call never gets; the casts keep today's types.
  return {
    async getWorkQueue(agentId: string): Promise<WorkQueue> {
      return (await api.call('work-queue.view_queue', { path: { agentId } })) as WorkQueue;
    },

    async updateWorkQueue(agentId: string, body: UpdateWorkQueueRequest): Promise<WorkQueue> {
      return (await api.call('work-queue.change_settings', {
        path: { agentId },
        body,
      })) as WorkQueue;
    },

    async setWorkQueuesStopped(stopped: boolean): Promise<SetWorkQueuesStoppedRequest> {
      return (await api.call('work-queue.stop_all', {
        body: { stopped },
      })) as SetWorkQueuesStoppedRequest;
    },

    async reorderWorkQueue(agentId: string, itemIds: string[]): Promise<WorkQueue> {
      return (await api.call('work-queue.set_order', {
        path: { agentId },
        body: { itemIds },
      })) as WorkQueue;
    },

    async addWorkItem(agentId: string, body: AddWorkItemRequest): Promise<WorkItem> {
      return (await api.call('work-queue.add_item', { path: { agentId }, body })) as WorkItem;
    },

    async removeWorkItem(agentId: string, itemId: string): Promise<void> {
      await api.call('work-queue.remove_item', { path: { agentId, itemId } });
    },

    async requeueWorkItem(agentId: string, itemId: string): Promise<WorkItem> {
      return (await api.call('work-queue.requeue_item', {
        path: { agentId, itemId },
        body: { status: 'queued' },
      })) as WorkItem;
    },
  };
}
