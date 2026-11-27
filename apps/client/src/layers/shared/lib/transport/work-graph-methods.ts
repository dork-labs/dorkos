/**
 * The work graph's reads (W4, DOR-4970): a chat's tree and the work an agent
 * or a chat did. Each path is its capability's own, on the capability mount.
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
import { buildQueryString, fetchJSON } from './http-client';

/** Create the work graph methods bound to a base URL. */
export function createWorkGraphMethods(baseUrl: string) {
  return {
    async getChatTree(chatId: string, query: ChatTreeQuery = {}): Promise<ChatTree> {
      const answer = await fetchJSON<unknown>(
        baseUrl,
        `/sessions/${encodeURIComponent(chatId)}/tree${buildQueryString({ cursor: query.cursor })}`
      );
      return ChatTreeSchema.parse(answer);
    },

    async getAgentWork(agentId: string, query: WorkQuery = {}): Promise<WorkPage> {
      const answer = await fetchJSON<unknown>(
        baseUrl,
        `/agents/${encodeURIComponent(agentId)}/work${buildQueryString({
          kind: query.kind,
          cursor: query.cursor,
        })}`
      );
      return WorkPageSchema.parse(answer);
    },

    async getChatWork(chatId: string, query: ChatWorkQuery = {}): Promise<WorkPage> {
      const answer = await fetchJSON<unknown>(
        baseUrl,
        `/sessions/${encodeURIComponent(chatId)}/work${buildQueryString({
          kind: query.kind,
          children: query.children,
          cursor: query.cursor,
        })}`
      );
      return WorkPageSchema.parse(answer);
    },
  };
}
