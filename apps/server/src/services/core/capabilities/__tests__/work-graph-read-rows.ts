/**
 * The work graph's reads, one row each, for the projection census (DOR-4973,
 * ADR 261127-215412): each is a capability the mount serves, not a hand route
 * (`http/__tests__/hand-route-census.test.ts`), and its one declaration shows
 * up in the OpenAPI document (`openapi-projection.test.ts`) and on both MCP
 * servers (`mcp-projection.test.ts`) under the same id, with the shared page
 * shape of `@dorkos/shared/paging`. `openapi-projection.test.ts` also checks
 * that these rows name every work graph read, so a new read fails there until
 * its row is added here.
 *
 * @module services/core/capabilities/__tests__/work-graph-read-rows
 */

/** One work graph read, as its declaration should project. */
export interface WorkGraphReadRow {
  /** The capability id, which is also the OpenAPI operation id. */
  readonly id: string;
  /** Its MCP tool name. */
  readonly tool: string;
  /** Its REST path, in OpenAPI spelling. */
  readonly path: string;
  /** The output field that holds the page's rows. */
  readonly list: string;
}

/** The work graph's reads. */
export const WORK_GRAPH_READ_ROWS: readonly WorkGraphReadRow[] = [
  {
    id: 'work-graph.agent_chats',
    tool: 'agent_chats',
    path: '/api/agents/{agentId}/chats',
    list: 'chats',
  },
  {
    id: 'work-graph.chat_tree',
    tool: 'chat_tree',
    path: '/api/sessions/{id}/tree',
    list: 'descendants',
  },
  {
    id: 'work-graph.agent_work',
    tool: 'work_for_agent',
    path: '/api/agents/{agentId}/work',
    list: 'items',
  },
  {
    id: 'work-graph.chat_work',
    tool: 'work_for_chat',
    path: '/api/sessions/{id}/work',
    list: 'items',
  },
];
