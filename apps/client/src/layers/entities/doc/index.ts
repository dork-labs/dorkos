/**
 * Doc entity: the docs in one space and the comments on them, read and
 * written over the Transport (DOR-2981 to DOR-2984). Wiki links resolve
 * against the doc index (DOR-2982); the rules that match a typed target to a
 * doc live in `@dorkos/shared/doc-links`, shared with the server. Comment
 * threads, who can be mentioned in them, and every write a thread takes are
 * DOR-2983.
 *
 * @module entities/doc
 */
export { docKeys } from './api/query-keys';
export { useDocIndex, useInvalidateDocIndex } from './model/use-doc-index';
export { docRefFor } from './lib/doc-ref';
export { docCommentKeys } from './model/doc-comment-keys';
export { useDocCommentThreads, useDocCommentMentionable } from './model/use-doc-comments';
export {
  useCreateDocCommentThread,
  useReplyDocComment,
  useSetDocCommentThreadResolved,
  useEditDocComment,
  useUpdateDocCommentAnchors,
  type CreateDocCommentThreadInput,
} from './model/use-doc-comment-mutations';
