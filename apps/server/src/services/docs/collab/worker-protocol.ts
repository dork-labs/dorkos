/**
 * The messages between the server and its markdown worker.
 *
 * The worker never holds a document between calls: every request carries the
 * Yjs state it works on, and every answer carries Yjs bytes back. That is what
 * keeps the live `Y.Doc` on the server's own thread, where syncing it with
 * editors stays fast however busy the worker is.
 *
 * @module services/docs/collab/worker-protocol
 */

/** What the server asks the worker to do. */
export type MarkdownWorkerRequest =
  /** Build a fresh document from markdown and return its whole state. */
  | { id: number; op: 'seed'; markdown: string }
  /** The markdown a document state holds, as an editor would write it. */
  | { id: number; op: 'serialize'; state: Uint8Array }
  /**
   * Write `markdown` into a copy of `state` and return only the change. With
   * `base`, only the writer's own edits since that base are applied (a
   * three-way merge); without it, the document is made to equal `markdown`.
   */
  | { id: number; op: 'merge'; state: Uint8Array; markdown: string; base?: Uint8Array };

/** Every operation name a request can carry. */
export type MarkdownWorkerOp = MarkdownWorkerRequest['op'];

/** What the worker answers when a request worked. */
export type MarkdownWorkerResult =
  | { op: 'seed'; state: Uint8Array }
  | { op: 'serialize'; markdown: string }
  | {
      op: 'merge';
      /** The Yjs update that turns `state` into the merged document. */
      update: Uint8Array;
      /** The base to hand back on the same writer's next write. */
      base: Uint8Array;
      /** The merged document, as markdown. */
      markdown: string;
      /**
       * With a base: the base plus only this writer's change, self-contained
       * (no deletions or items from anyone else). What a file written by this
       * writer reflects, and the next base for the same writer's next change.
       */
      reflected?: Uint8Array;
    };

/** Why a request did not work. */
export type MarkdownWorkerFailureCode =
  /** The base belongs to another document, or to a newer copy of this one. */
  | 'BASE_MISMATCH'
  /** Anything else: a parse failure, a bug, a worker that died. */
  | 'FAILED';

/** One answer, matched to its request by `id`. */
export type MarkdownWorkerResponse =
  | ({ id: number; ok: true } & MarkdownWorkerResult)
  | { id: number; ok: false; code: MarkdownWorkerFailureCode; message: string };
