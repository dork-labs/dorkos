/**
 * The doc comments slice of the {@link Transport} port (DOR-2983): threads on
 * a markdown doc, who can be mentioned, and every write a thread takes.
 *
 * Split out of `transport.ts` the way the commitments slice is: `Transport`
 * extends this, so nothing consuming the port sees a difference.
 *
 * @module shared/transport-doc-comments
 */
import type {
  CreateDocCommentThreadRequest,
  DocCommentMentionableList,
  DocCommentThreadList,
  DocCommentThreadResult,
  DocCommentWriteResult,
  DocRef,
  EditDocCommentRequest,
  ReplyDocCommentRequest,
  SetDocCommentThreadResolvedRequest,
  UpdateDocCommentAnchorsRequest,
  UpdateDocCommentAnchorsResult,
} from './doc-comments.js';

/** The doc comment methods every Transport implements. */
export interface DocCommentTransport {
  /**
   * Every thread on a doc, resolved ones included, oldest first.
   *
   * @param doc - The doc: its folder and its path inside it.
   */
  listDocCommentThreads(doc: DocRef): Promise<DocCommentThreadList>;

  /** Everybody a comment can `@`-mention. */
  listDocCommentMentionable(): Promise<DocCommentMentionableList>;

  /**
   * Open a thread on some words, with its first comment.
   *
   * @param body - The doc, the editor's anchor, and the comment.
   */
  createDocCommentThread(body: CreateDocCommentThreadRequest): Promise<DocCommentWriteResult>;

  /**
   * Add a comment to a thread.
   *
   * @param threadId - The thread.
   * @param body - The doc and the comment.
   */
  replyDocComment(threadId: string, body: ReplyDocCommentRequest): Promise<DocCommentWriteResult>;

  /**
   * Mark a thread done, or open it again.
   *
   * @param threadId - The thread.
   * @param body - The doc, and whether it is resolved.
   */
  setDocCommentThreadResolved(
    threadId: string,
    body: SetDocCommentThreadResolvedRequest
  ): Promise<DocCommentThreadResult>;

  /**
   * Change your own comment.
   *
   * @param threadId - The thread.
   * @param commentId - The comment.
   * @param body - The doc and the new words.
   */
  editDocComment(
    threadId: string,
    commentId: string,
    body: EditDocCommentRequest
  ): Promise<DocCommentThreadResult>;

  /**
   * Save the anchors the editor moved.
   *
   * @param body - The doc and each moved thread's fresh anchor.
   */
  updateDocCommentAnchors(
    body: UpdateDocCommentAnchorsRequest
  ): Promise<UpdateDocCommentAnchorsResult>;
}
