/**
 * What happened, as the client reads it: the activity feed, the audit record
 * (spec `audit-trail` PR4) and what a chat sent other chats. Split out of
 * `transport.ts`, which `Transport` extends.
 *
 * @module shared/transport-activity
 */
import type { ChatActivityResponse } from './chat-messages.js';
import type { ListActivityQuery, ListActivityResponse } from './activity-schemas.js';
import type { AuditQuery, AuditQueryResult, AuditTimelineQuery } from './audit-schemas.js';

/** Reading what happened: the activity feed, the audit record and chat activity. */
export interface ActivityTransport {
  /** List activity events with optional filters and cursor-based pagination. */
  listActivityEvents(query?: Partial<ListActivityQuery>): Promise<ListActivityResponse>;

  /**
   * List audit events the caller may see, newest first. Page backwards by
   * passing the previous page's `nextBeforeSeq` as `beforeSeq`.
   */
  listAuditEvents(query?: Partial<AuditQuery>): Promise<AuditQueryResult>;

  /**
   * Everything one account did, had done to it, or had done on its behalf,
   * newest first. For an agent, `accountId` is the agent's id.
   *
   * @param accountId - The account whose timeline to read.
   * @param query - Optional filters and the `beforeSeq` page cursor.
   */
  getAccountTimeline(
    accountId: string,
    query?: Partial<Omit<AuditTimelineQuery, 'accountId'>>
  ): Promise<AuditQueryResult>;

  /**
   * What a chat sent other chats, and the times another chat stopped it (spec
   * `spin-off-chats` §6): the Sent cards and the "Stopped by" lines. Re-read
   * whenever the chat's stream carries a `chat_activity` event.
   *
   * @param sessionId - The chat.
   */
  getChatActivity(sessionId: string): Promise<ChatActivityResponse>;
}
