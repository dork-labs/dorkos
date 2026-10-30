import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { AddWorkItemRequest, UpdateWorkQueueRequest } from '@dorkos/shared/work-queue-schemas';
import { useTransport } from '@/layers/shared/model';

/** How often a queue re-reads: the server starts items on its own. */
const REFRESH_MS = 10_000;

/** The query key of one agent's queue. */
const queueKey = (agentId: string) => ['work-queue', agentId] as const;

/** Re-read one agent's queue after a write. */
const refresh = (queryClient: QueryClient, agentId: string) =>
  queryClient.invalidateQueries({ queryKey: queueKey(agentId) });

/**
 * One agent's work queue.
 *
 * @param agentId - The agent's Mesh id.
 * @returns The TanStack Query result for `GET /api/agents/:id/work-queue`.
 */
export function useWorkQueue(agentId: string) {
  const transport = useTransport();
  return useQuery({
    queryKey: queueKey(agentId),
    queryFn: () => transport.getWorkQueue(agentId),
    refetchInterval: REFRESH_MS,
  });
}

/**
 * Pause or resume a queue, or set its target.
 *
 * @param agentId - The agent's Mesh id.
 * @returns The TanStack mutation.
 */
export function useUpdateWorkQueue(agentId: string) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateWorkQueueRequest) => transport.updateWorkQueue(agentId, body),
    onSettled: () => refresh(queryClient, agentId),
  });
}

/**
 * Stop every queue on this install, or lift the stop.
 *
 * @returns The TanStack mutation.
 */
export function useSetWorkQueuesStopped() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (stopped: boolean) => transport.setWorkQueuesStopped(stopped),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['work-queue'] }),
  });
}

/**
 * Set the order of what is waiting.
 *
 * @param agentId - The agent's Mesh id.
 * @returns The TanStack mutation.
 */
export function useReorderWorkQueue(agentId: string) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (itemIds: string[]) => transport.reorderWorkQueue(agentId, itemIds),
    onSettled: () => refresh(queryClient, agentId),
  });
}

/**
 * Add an item to the back of a queue.
 *
 * @param agentId - The agent's Mesh id.
 * @returns The TanStack mutation.
 */
export function useAddWorkItem(agentId: string) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AddWorkItemRequest) => transport.addWorkItem(agentId, body),
    onSettled: () => refresh(queryClient, agentId),
  });
}

/**
 * Remove an item that is still waiting.
 *
 * @param agentId - The agent's Mesh id.
 * @returns The TanStack mutation.
 */
export function useRemoveWorkItem(agentId: string) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => transport.removeWorkItem(agentId, itemId),
    onSettled: () => refresh(queryClient, agentId),
  });
}

/**
 * Queue an ended item again.
 *
 * @param agentId - The agent's Mesh id.
 * @returns The TanStack mutation.
 */
export function useRequeueWorkItem(agentId: string) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => transport.requeueWorkItem(agentId, itemId),
    onSettled: () => refresh(queryClient, agentId),
  });
}
