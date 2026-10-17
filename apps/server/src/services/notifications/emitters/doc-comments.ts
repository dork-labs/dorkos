/**
 * Turns an agent's doc comment into `doc.comment` (DOR-2983).
 *
 * The decision lives in the docs domain (`services/docs/comments/`): it knows
 * who wrote the comment and whom it mentioned. This module only shapes that
 * into the one `notify()` call.
 *
 * @module services/notifications/emitters/doc-comments
 */
import path from 'node:path';
import { notify } from '../notification-service.js';
import { roomMessagePreview } from './room-messages.js';

/** What one agent comment is, as far as this module needs to know. */
export interface DocCommentNotifyInput {
  /** The comment's id. */
  commentId: string;
  /** The thread it is in. */
  threadId: string;
  /** The Mesh id of the agent that wrote it. */
  agentId: string;
  /** The agent's name. */
  agentName: string;
  /** The doc's path inside its folder. */
  docPath: string;
  /** Whether the comment mentions the operator. */
  mentionsYou: boolean;
  /** The comment's words. */
  body: string;
}

/**
 * Tell the operator an agent commented on one of their docs. Fire-and-forget
 * and never throws, like every emitter here: a notification problem must never
 * fail the comment that produced it.
 *
 * @param input - The comment and what the docs domain decided about it.
 */
export function notifyDocComment(input: DocCommentNotifyInput): void {
  void notify('doc.comment', {
    commentId: input.commentId,
    threadId: input.threadId,
    agentId: input.agentId,
    agentName: input.agentName,
    docName: path.posix.basename(input.docPath),
    mentionsYou: input.mentionsYou,
    preview: roomMessagePreview(input.body),
  });
}
