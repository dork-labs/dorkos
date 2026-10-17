/**
 * Why a doc comment request was refused (DOR-2983), in words a person or an
 * agent can act on.
 *
 * @module services/docs/comments/comment-errors
 */

/** Every refusal the comment service makes. */
export type DocCommentErrorCode =
  /** The thread or comment is not on this doc. */
  | 'NOT_FOUND'
  /** Only a comment's author may change it. */
  | 'NOT_YOURS'
  /** An agent asked to comment on a range that cannot be anchored. */
  | 'UNADDRESSABLE_RANGE'
  /** The caller is not an author DorkOS can write as. */
  | 'NO_AUTHOR';

/** A refused comment request. */
export class DocCommentError extends Error {
  /**
   * A refusal.
   *
   * @param code - Which rule refused it.
   * @param message - What was wrong, in words the caller can show.
   */
  constructor(
    readonly code: DocCommentErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'DocCommentError';
  }
}
