/**
 * The work graph's reads (W4, DOR-4970): a chat's tree and the work an agent
 * or a chat did. Each path is its capability's own, on the capability mount,
 * called through the generated API client (DOR-5473).
 *
 * @module shared/lib/transport/work-graph-methods
 */
import {
  ChatTreeSchema,
  WorkPageSchema,
  type ChatTree,
  type WorkPage,
} from '@dorkos/shared/work-graph-reads';
import type { ChatTreeQuery, ChatWorkQuery, WorkQuery } from '@dorkos/shared/transport-work-graph';
import { createTransportApiClient } from './api-client';

/** Create the work graph methods bound to a base URL. */
export function createWorkGraphMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    async getChatTree(chatId: string, query: ChatTreeQuery = {}): Promise<ChatTree> {
      const answer = await api.call('work-graph.chat_tree', {
        path: { id: chatId },
        query: { cursor: query.cursor },
      });
      return ChatTreeSchema.parse(answer);
    },

    async getAgentWork(agentId: string, query: WorkQuery = {}): Promise<WorkPage> {
      const answer = await api.call('work-graph.agent_work', {
        path: { agentId },
        query: { kind: query.kind, cursor: query.cursor },
      });
      return WorkPageSchema.parse(answer);
    },

    async getChatWork(chatId: string, query: ChatWorkQuery = {}): Promise<WorkPage> {
      const answer = await api.call('work-graph.chat_work', {
        path: { id: chatId },
        query: { kind: query.kind, children: query.children, cursor: query.cursor },
      });
      return WorkPageSchema.parse(answer);
    },
  };
}
