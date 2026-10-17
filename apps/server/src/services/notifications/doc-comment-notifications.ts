/**
 * What DorkOS says when an agent comments on one of the operator's docs
 * (DOR-2983): a comment, a reply in a thread, or a mention of the operator.
 *
 * Declared here and spread into the registry through
 * `domain-notification-entries.ts`, which reads exactly like any other entry.
 * The emitter is `emitters/doc-comments.ts`, called from
 * `services/docs/comments/comment-service.ts`: raised for every comment an
 * agent writes, since every doc on this computer is the operator's, and never
 * for the operator's own words.
 *
 * @module services/notifications/doc-comment-notifications
 */
import type { NotificationRegistryEntry } from './notification-registry.js';

/** The payload each doc-comment kind carries. */
export interface DocCommentPayloads {
  /** An agent commented on one of the operator's docs, or mentioned them there. */
  'doc.comment': {
    /** The comment's id: what makes two of these the same. */
    commentId: string;
    /** The thread it is in. */
    threadId: string;
    /** The agent that wrote it. The lens key. */
    agentId: string;
    /** What to call the agent. */
    agentName: string;
    /** The doc's file name, e.g. `plan.md`. */
    docName: string;
    /** Whether the comment mentions the operator. */
    mentionsYou: boolean;
    /** The opening of the comment, already truncated. */
    preview: string;
  };
}

/** The doc-comment kinds. */
type DocCommentKind = keyof DocCommentPayloads;

/**
 * The doc-comment entries. Dedupes per comment, like `mention.received`, and
 * stays in the app, never sent over a chat connection: a doc comment is one of
 * many on a page the person opens when they choose to.
 */
export const DOC_COMMENT_ENTRIES: { [K in DocCommentKind]: NotificationRegistryEntry<K> } = {
  'doc.comment': {
    kind: 'doc.comment',
    tier: 'notable',
    storage: 'event',
    subjectType: 'agent',
    locate: (p) => ({ subjectId: p.agentId, agentId: p.agentId }),
    title: (p) =>
      p.mentionsYou
        ? `${p.agentName} mentioned you in ${p.docName}`
        : `${p.agentName} commented on ${p.docName}`,
    body: (p) => p.preview,
    dedupeKey: (p) => `doc-comment:${p.commentId}`,
    relay: 'never',
  },
};
