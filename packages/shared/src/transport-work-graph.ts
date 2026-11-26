/**
 * The work graph's reads (W4, DOR-4970), as the client reaches them: a chat's
 * tree, and the pull requests and tickets an agent or a chat worked on. A
 * slice of the `Transport` (`transport-slices.ts`).
 *
 * @module shared/transport-work-graph
 */
import type { ChatTree, WorkKind, WorkPage } from './work-graph-reads.js';

/** Which page of a chat's tree. */
export interface ChatTreeQuery {
  /** The `nextCursor` of the page before, if any. */
  cursor?: string;
}

/** Which page of work, and of what kind. */
export interface WorkQuery {
  /** Only pull requests, or only tickets. Both when left out. */
  kind?: WorkKind;
  /** The `nextCursor` of the page before, if any. */
  cursor?: string;
}

/** Which page of a chat's work: the chat alone, or with the chats below it. */
export interface ChatWorkQuery extends WorkQuery {
  /** Include the chats below it (the default) or not. */
  children?: boolean;
}

/** Read the work graph: chats that started each other, and the work they did. */
export interface WorkGraphTransport {
  /**
   * A chat's ancestors and one page of the chats below it, depth first
   * (`GET /api/sessions/{id}/tree`). The ancestors repeat on every page.
   *
   * @param chatId - The chat's id.
   * @param query - Which page.
   */
  getChatTree(chatId: string, query?: ChatTreeQuery): Promise<ChatTree>;
  /**
   * One page of the pull requests and tickets an agent's chats are linked to
   * (`GET /api/agents/{agentId}/work`), newest first.
   *
   * @param agentId - The agent's registry id.
   * @param query - Which kind, and which page.
   */
  getAgentWork(agentId: string, query?: WorkQuery): Promise<WorkPage>;
  /**
   * One page of the pull requests and tickets a chat, and by default the chats
   * below it, are linked to (`GET /api/sessions/{id}/work`), newest first.
   *
   * @param chatId - The chat's id.
   * @param query - Which kind, whether to include its children, and which page.
   */
  getChatWork(chatId: string, query?: ChatWorkQuery): Promise<WorkPage>;
}
