/**
 * Doc comments Transport method factory (DOR-2983): the app's side of
 * `/api/documents/comments`.
 *
 * @module shared/lib/transport/doc-comment-methods
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
} from '@dorkos/shared/doc-comments';
import { fetchJSON } from './http-client';

const BASE = '/documents/comments';

/**
 * Create the doc comment methods bound to a base URL.
 *
 * Every write carries this window's `X-Client-Id`, a marker the server asks
 * for before it reads a comment as the owner's request with login off. It is
 * not a credential (any program can send one); the protection is login
 * (`routes/doc-comment-caller.ts`).
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 * @param getClientId - This window's client id.
 */
export function createDocCommentMethods(baseUrl: string, getClientId: () => string) {
  const write = <T>(path: string, method: 'POST' | 'PATCH' | 'PUT', body: unknown): Promise<T> =>
    fetchJSON(baseUrl, path, {
      method,
      headers: { 'X-Client-Id': getClientId() },
      body: JSON.stringify(body),
    });
  const thread = (threadId: string) => `${BASE}/threads/${encodeURIComponent(threadId)}`;

  return {
    listDocCommentThreads(doc: DocRef): Promise<DocCommentThreadList> {
      const params = new URLSearchParams({ cwd: doc.cwd, path: doc.path });
      return fetchJSON(baseUrl, `${BASE}?${params.toString()}`);
    },

    listDocCommentMentionable(): Promise<DocCommentMentionableList> {
      return fetchJSON(baseUrl, `${BASE}/mentionable`);
    },

    createDocCommentThread(body: CreateDocCommentThreadRequest): Promise<DocCommentWriteResult> {
      return write(`${BASE}/threads`, 'POST', body);
    },

    replyDocComment(
      threadId: string,
      body: ReplyDocCommentRequest
    ): Promise<DocCommentWriteResult> {
      return write(`${thread(threadId)}/replies`, 'POST', body);
    },

    setDocCommentThreadResolved(
      threadId: string,
      body: SetDocCommentThreadResolvedRequest
    ): Promise<DocCommentThreadResult> {
      return write(thread(threadId), 'PATCH', body);
    },

    editDocComment(
      threadId: string,
      commentId: string,
      body: EditDocCommentRequest
    ): Promise<DocCommentThreadResult> {
      return write(`${thread(threadId)}/comments/${encodeURIComponent(commentId)}`, 'PATCH', body);
    },

    updateDocCommentAnchors(
      body: UpdateDocCommentAnchorsRequest
    ): Promise<UpdateDocCommentAnchorsResult> {
      return write(`${BASE}/anchors`, 'PUT', body);
    },
  };
}
