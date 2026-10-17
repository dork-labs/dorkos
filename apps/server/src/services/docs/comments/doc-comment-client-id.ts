/**
 * The lock identity a doc comment's wake is sent under (DOR-2983):
 * `doc-comment:owner` when the owner wrote the comment, `doc-comment:bounded`
 * for anybody else. It is how a queue row says a doc comment sent it, and the
 * dispatcher reads it for one rule: a bounded row launches no looser than the
 * ceiling it was sent with, and at the runtime's default when that ceiling is
 * gone (a row adopted after a restart has no in-memory plan to carry one). It
 * fails closed.
 *
 * Leaf module: the dispatcher imports it, so it imports nothing of ours.
 *
 * @module services/docs/comments/doc-comment-client-id
 */

/** The lock identity of a wake the owner's own comment sent. */
export const DOC_COMMENT_OWNER_CLIENT_ID = 'doc-comment:owner';

/** The lock identity of a wake anybody else's comment sent. */
export const DOC_COMMENT_BOUNDED_CLIENT_ID = 'doc-comment:bounded';

/**
 * Whether a lock identity (a queue row's `enqueuedBy`) is a doc comment wake
 * that must be held to a ceiling.
 *
 * @param clientId - The identity.
 */
export function isBoundedDocCommentClientId(clientId: string): boolean {
  return clientId === DOC_COMMENT_BOUNDED_CLIENT_ID;
}
