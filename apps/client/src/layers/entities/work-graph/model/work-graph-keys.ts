/**
 * Query keys for the work graph's reads, in one place so a surface that knows
 * the graph moved can refresh what it drew.
 *
 * @module entities/work-graph/model/work-graph-keys
 */
import type { WorkKind } from '@dorkos/shared/work-graph-reads';

/** Every work graph query sits under this prefix. */
const WORK_GRAPH_KEY = ['work-graph'] as const;

/** The query keys the work graph hooks read under. */
export const workGraphKeys = {
  /** Everything the work graph answers. */
  all: WORK_GRAPH_KEY,
  /** `GET /api/sessions/{id}/tree`, every page, for one chat. */
  tree: (chatId: string) => [...WORK_GRAPH_KEY, 'tree', chatId] as const,
  /** `GET /api/agents/{agentId}/work`, every page, of one kind. */
  agentWork: (agentId: string, kind: WorkKind) =>
    [...WORK_GRAPH_KEY, 'work', 'agent', agentId, kind] as const,
  /** `GET /api/sessions/{id}/work` with the chats below it, every page, of one kind. */
  chatWork: (chatId: string, kind: WorkKind) =>
    [...WORK_GRAPH_KEY, 'work', 'chat', chatId, kind] as const,
};
