/**
 * Work queue Transport method factory (DOR-3462).
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
import { fetchJSON, fetchNoContent } from './http-client';

/**
 * Create the work queue methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 */
export function createWorkQueueMethods(baseUrl: string) {
  const queuePath = (agentId: string) => `/agents/${encodeURIComponent(agentId)}/work-queue`;
  const itemPath = (agentId: string, itemId: string) =>
    `${queuePath(agentId)}/items/${encodeURIComponent(itemId)}`;
  return {
    getWorkQueue(agentId: string): Promise<WorkQueue> {
      return fetchJSON(baseUrl, queuePath(agentId));
    },

    updateWorkQueue(agentId: string, body: UpdateWorkQueueRequest): Promise<WorkQueue> {
      return fetchJSON(baseUrl, queuePath(agentId), {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    },

    setWorkQueuesStopped(stopped: boolean): Promise<SetWorkQueuesStoppedRequest> {
      return fetchJSON(baseUrl, '/work-queues/stop', {
        method: 'PUT',
        body: JSON.stringify({ stopped }),
      });
    },

    reorderWorkQueue(agentId: string, itemIds: string[]): Promise<WorkQueue> {
      return fetchJSON(baseUrl, `${queuePath(agentId)}/order`, {
        method: 'PUT',
        body: JSON.stringify({ itemIds }),
      });
    },

    addWorkItem(agentId: string, body: AddWorkItemRequest): Promise<WorkItem> {
      return fetchJSON(baseUrl, `${queuePath(agentId)}/items`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    removeWorkItem(agentId: string, itemId: string): Promise<void> {
      return fetchNoContent(baseUrl, itemPath(agentId, itemId), { method: 'DELETE' });
    },

    requeueWorkItem(agentId: string, itemId: string): Promise<WorkItem> {
      return fetchJSON(baseUrl, `${itemPath(agentId, itemId)}/requeue`, { method: 'POST' });
    },
  };
}
