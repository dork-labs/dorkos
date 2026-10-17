/**
 * Query keys for doc comments, in one place so every write can update the
 * list it changes.
 *
 * @module entities/doc/model/doc-comment-keys
 */
import type { DocRef } from '@dorkos/shared/doc-comments';

/** Every doc comment query sits under this prefix. */
const DOC_COMMENTS_KEY = ['doc-comments'] as const;

/** The query keys the doc comment hooks read under. */
export const docCommentKeys = {
  /** Everything doc-comment-shaped. */
  all: DOC_COMMENTS_KEY,
  /** One doc's threads. */
  threads: (doc: DocRef) => [...DOC_COMMENTS_KEY, 'threads', doc.cwd, doc.path] as const,
  /** Who a comment can mention. */
  mentionable: () => [...DOC_COMMENTS_KEY, 'mentionable'] as const,
};
