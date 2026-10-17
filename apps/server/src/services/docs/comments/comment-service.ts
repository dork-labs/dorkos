/**
 * Comments on docs (DOR-2983): the one place a thread is opened, answered,
 * resolved, edited or re-anchored, whether a person does it in the app or an
 * agent does it with its tools.
 *
 * ## What a write does, in order
 *
 * 1. **Resolves its mentions once**, against every agent and the owner, by the
 *    rooms' grammar (`rooms/mentions.ts`). Stored on the comment; an edit later
 *    never re-addresses anybody.
 * 2. **Stamps its cascade** with the rooms' rule (`deriveCascade`): a person's
 *    comment starts a fresh chain, an agent's comment continues the chain its
 *    woken turn carries, and an agent's comment with no such turn is stamped
 *    already spent.
 * 3. **Writes** the comment (and the thread, for the first one).
 * 4. **Tells the owner** when an agent wrote it (`doc.comment`).
 * 5. **Wakes the agents it mentions** through the cascade guard
 *    (`comment-wake.ts`), each with words framed by who wrote them
 *    (`comment-wake-prompt.ts`).
 *
 * Steps 4 and 5 run after the write is durable, and neither can fail it.
 *
 * @module services/docs/comments/comment-service
 */
import { ulid } from 'ulidx';
import type {
  DocComment,
  DocCommentAnchor,
  DocCommentAuthor,
  DocCommentMentionable,
  DocCommentThread,
} from '@dorkos/shared/doc-comments';
import type { DocCommentRow } from '@dorkos/db';
import { logError, logger } from '../../../lib/logger.js';
import { deriveCascade } from '../../rooms/cascade-guard.js';
import { resolveMentions } from '../../rooms/mentions.js';
import type { AuthorRecord } from '../../rooms/author-registry.js';
import type { DocCommentNotifyInput } from '../../notifications/emitters/doc-comments.js';
import type { CommentDirectory } from './comment-directory.js';
import { DocCommentError } from './comment-errors.js';
import type { DocCommentStore, StoredDocCommentThread } from './comment-store.js';
import { renderCommentWake, type WakeComment } from './comment-wake-prompt.js';
import type { CommentWaker, CommentWakeLimits, WakeOutcome, WakeTarget } from './comment-wake.js';
import type { DocLocation } from './doc-location.js';

/** Who is writing, as the caller verified it. */
export interface CommentWriter {
  /** The author. Never read from a request body. */
  author: AuthorRecord;
  /** The chat an agent's tool call came from, from the verified turn. */
  sessionId?: string;
  /**
   * Whether the request is the owner in person, by the person bars
   * (`routes/doc-comment-caller.ts`). Only then do the owner's words count as
   * a request; an owner author without it is written as an outsider.
   */
  inPerson?: boolean;
}

/** A mentioned agent that was not woken, and why. */
export type UnreachedMention = Extract<WakeOutcome, { woken: false }>;

/** What a write answers with. */
export interface CommentWriteResult {
  /** The thread as it is now. */
  thread: DocCommentThread;
  /** Mentioned agents that were not woken. Empty when everyone was. */
  unreached: UnreachedMention[];
}

/** What the comment service needs. */
export interface DocCommentServiceDeps {
  /** Where comments live. */
  store: DocCommentStore;
  /** Authors, mentions and trust. */
  directory: CommentDirectory;
  /** Wakes mentioned agents. */
  waker: Pick<CommentWaker, 'wake' | 'cascadeFor'>;
  /** The reply limits, read per call. */
  limits: () => CommentWakeLimits;
  /** Tell the owner about an agent's comment. */
  notify: (input: DocCommentNotifyInput) => void;
  /** The clock (tests pin it). */
  now?: () => number;
}

/** The comment service. See the module documentation. */
export class DocCommentService {
  private readonly now: () => number;

  /**
   * Build the service.
   *
   * @param deps - What it needs.
   */
  constructor(private readonly deps: DocCommentServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Every thread on a doc, oldest first.
   *
   * @param doc - The doc.
   */
  list(doc: DocLocation): DocCommentThread[] {
    return this.views(doc, this.deps.store.listThreads(doc.key));
  }

  /** Everybody a comment can mention. */
  mentionable(): DocCommentMentionable[] {
    return this.deps.directory.mentionable();
  }

  /**
   * Open a thread on some words of a doc, with its first comment.
   *
   * @param doc - The doc.
   * @param writer - Who is writing.
   * @param input - Where it sits and what it says.
   */
  async createThread(
    doc: DocLocation,
    writer: CommentWriter,
    input: { anchor: DocCommentAnchor; body: string }
  ): Promise<CommentWriteResult> {
    const at = this.stamp();
    const threadId = ulid();
    const comment = this.newComment(threadId, writer, input.body, at);
    const stored = this.deps.store.insertThread(
      {
        id: threadId,
        docKey: doc.key,
        spaceKey: doc.space.key,
        docPath: doc.path,
        anchorJson: JSON.stringify(input.anchor),
        createdByAuthorId: writer.author.id,
        createdAt: at,
      },
      comment
    );
    return this.afterWrite(doc, stored, stored.comments[0]!, writer);
  }

  /**
   * Add a comment to a thread.
   *
   * @param doc - The doc.
   * @param writer - Who is writing.
   * @param threadId - The thread.
   * @param body - What it says.
   * @throws DocCommentError `NOT_FOUND` when the thread is not on this doc.
   */
  async reply(
    doc: DocLocation,
    writer: CommentWriter,
    threadId: string,
    body: string
  ): Promise<CommentWriteResult> {
    this.requireThread(doc, threadId);
    const row = this.deps.store.insertComment(
      this.newComment(threadId, writer, body, this.stamp())
    );
    return this.afterWrite(doc, this.requireThread(doc, threadId), row, writer);
  }

  /**
   * Mark a thread done, or open it again. Anybody who can comment may.
   *
   * @param doc - The doc.
   * @param writer - Who is doing it.
   * @param threadId - The thread.
   * @param resolved - `true` to mark it done.
   * @throws DocCommentError `NOT_FOUND` when the thread is not on this doc.
   */
  setResolved(
    doc: DocLocation,
    writer: CommentWriter,
    threadId: string,
    resolved: boolean
  ): DocCommentThread {
    this.requireThread(doc, threadId);
    this.deps.store.setResolved(threadId, resolved, writer.author.id, this.stamp());
    return this.view(doc, this.requireThread(doc, threadId));
  }

  /**
   * Change your own comment. Its mentions stay what they were when it was
   * written, so an edit never wakes anybody, and so does its trust: a comment
   * written as the owner's request can be changed only by the owner in the
   * app, so its words stay the owner's.
   *
   * @param doc - The doc.
   * @param writer - Who is editing.
   * @param threadId - The thread.
   * @param commentId - The comment.
   * @param body - Its new words.
   * @throws DocCommentError `NOT_FOUND`, or `NOT_YOURS` for somebody else's
   *   comment, or for the owner's in-person comment edited from outside the app.
   */
  edit(
    doc: DocLocation,
    writer: CommentWriter,
    threadId: string,
    commentId: string,
    body: string
  ): DocCommentThread {
    this.requireThread(doc, threadId);
    const comment = this.deps.store.getComment(threadId, commentId);
    if (!comment) throw new DocCommentError('NOT_FOUND', 'That comment is not in this thread.');
    if (comment.authorId !== writer.author.id) {
      throw new DocCommentError('NOT_YOURS', 'Only the person who wrote a comment can change it.');
    }
    // The owner's request stays the owner's: only the owner in the app may
    // rewrite it, never a program holding the owner's identity.
    if (comment.trust === 'owner' && writer.inPerson !== true) {
      throw new DocCommentError('NOT_YOURS', 'Change this comment in the DorkOS app.');
    }
    this.deps.store.editComment(comment, body, this.stamp());
    return this.view(doc, this.requireThread(doc, threadId));
  }

  /**
   * Save the anchors the editor moved. Ids that are not this doc's threads
   * are skipped, and so are threads the caller may not move: a person in the
   * app moves any thread (their editor reports them), anybody else only the
   * threads it opened, and never one the owner opened in person.
   *
   * @param doc - The doc.
   * @param writer - Who is saving them.
   * @param updates - Each thread and its fresh anchor.
   * @returns How many threads took a new anchor.
   */
  updateAnchors(
    doc: DocLocation,
    writer: CommentWriter,
    updates: ReadonlyArray<{ id: string; anchor: DocCommentAnchor }>
  ): number {
    const movable = writer.inPerson === true ? null : this.movableBy(doc, writer.author.id);
    return this.deps.store.updateAnchors(
      doc.key,
      updates
        .filter(({ id }) => movable === null || movable.has(id))
        .map(({ id, anchor }) => ({ id, anchorJson: JSON.stringify(anchor) }))
    );
  }

  /**
   * The threads on a doc a caller that is not a person in the app may move:
   * the ones it opened, and never one opened as the owner's own request.
   */
  private movableBy(doc: DocLocation, authorId: string): Set<string> {
    return new Set(
      this.deps.store
        .listThreads(doc.key)
        .filter(
          ({ thread, comments }) =>
            thread.createdByAuthorId === authorId && comments[0]?.trust !== 'owner'
        )
        .map(({ thread }) => thread.id)
    );
  }

  /**
   * One thread as stored, or a refusal.
   *
   * @param doc - The doc.
   * @param threadId - The thread.
   * @throws DocCommentError `NOT_FOUND` when the thread is not on this doc.
   */
  requireThread(doc: DocLocation, threadId: string): StoredDocCommentThread {
    const stored = this.deps.store.getThread(doc.key, threadId);
    if (!stored) throw new DocCommentError('NOT_FOUND', 'That thread is not on this doc.');
    return stored;
  }

  /**
   * Threads as a reader sees them.
   *
   * @param doc - The doc.
   * @param stored - The stored threads.
   */
  views(doc: DocLocation, stored: readonly StoredDocCommentThread[]): DocCommentThread[] {
    const ids = stored.flatMap(({ thread, comments }) => [
      ...(thread.resolvedByAuthorId ? [thread.resolvedByAuthorId] : []),
      ...comments.map((comment) => comment.authorId),
    ]);
    const authors = this.deps.directory.describe(ids);
    return stored.map((entry) => toThread(doc, entry, authors));
  }

  private view(doc: DocLocation, stored: StoredDocCommentThread): DocCommentThread {
    return this.views(doc, [stored])[0]!;
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  /** A comment row, with its mentions and its cascade decided. */
  private newComment(
    threadId: string,
    writer: CommentWriter,
    body: string,
    at: string
  ): Omit<DocCommentRow, 'editedAt'> {
    const id = ulid();
    const mentions = resolveMentions(body, this.deps.directory.mentionCandidates()).filter(
      (authorId) => authorId !== writer.author.id
    );
    // Provenance follows the turn, never the call: only a chat a comment woke
    // carries a cascade, and it is looked up by the verified calling chat.
    const trigger =
      writer.author.kind === 'agent' && writer.sessionId
        ? this.deps.waker.cascadeFor(writer.sessionId)
        : undefined;
    const cascade = deriveCascade(id, {
      ...(trigger ? { trigger } : {}),
      authorKind: writer.author.kind,
      maxAgentDepth: this.deps.limits().maxAgentDepth,
    });
    return {
      id,
      threadId,
      authorId: writer.author.id,
      body,
      mentionsJson: JSON.stringify(mentions),
      trust: this.deps.directory.trustOf(writer.author, writer.inPerson === true),
      cascadeRoot: cascade.cascadeRoot,
      cascadeDepth: cascade.cascadeDepth,
      createdAt: at,
    };
  }

  /** Steps 4 and 5 of the module documentation. Never throws. */
  private async afterWrite(
    doc: DocLocation,
    stored: StoredDocCommentThread,
    row: DocCommentRow,
    writer: CommentWriter
  ): Promise<CommentWriteResult> {
    const thread = this.view(doc, stored);
    const mentions = parseMentions(row.mentionsJson);
    let unreached: UnreachedMention[] = [];
    try {
      this.notifyOwner(doc, row, writer, mentions);
      unreached = await this.wakeMentioned(doc, stored, thread, row, writer, mentions);
    } catch (err) {
      logger.warn('[doc-comments] a comment was saved, but its follow-ups failed', {
        threadId: row.threadId,
        ...logError(err),
      });
    }
    return { thread, unreached };
  }

  private notifyOwner(
    doc: DocLocation,
    row: DocCommentRow,
    writer: CommentWriter,
    mentions: readonly string[]
  ): void {
    const agent = this.deps.directory.agentOf(writer.author);
    if (!agent) return;
    const mentioned = this.deps.directory.describe(mentions);
    this.deps.notify({
      commentId: row.id,
      threadId: row.threadId,
      agentId: agent.agentId,
      agentName: agent.name,
      docPath: doc.path,
      mentionsYou: [...mentioned.values()].some((author) => author.isOwner),
      body: row.body,
    });
  }

  private async wakeMentioned(
    doc: DocLocation,
    stored: StoredDocCommentThread,
    thread: DocCommentThread,
    row: DocCommentRow,
    writer: CommentWriter,
    mentions: readonly string[]
  ): Promise<UnreachedMention[]> {
    const records = this.deps.directory.records(mentions);
    const targets: WakeTarget[] = [];
    for (const id of mentions) {
      const record = records.get(id);
      const agent = record ? this.deps.directory.agentOf(record) : null;
      if (agent) targets.push({ ...agent, authorId: id });
    }
    if (targets.length === 0) return [];

    const trust = row.trust;
    const index = stored.comments.findIndex((comment) => comment.id === row.id);
    // Each earlier comment is labelled with the trust it was written with, so
    // an owner author who was not in person reads as what they were.
    const earlier: WakeComment[] = stored.comments
      .slice(0, Math.max(index, 0))
      .map((comment, i) => ({
        authorName: thread.comments[i]?.author.displayName ?? 'Someone',
        authorTrust: comment.trust,
        body: comment.body,
      }));
    const quote = typeof thread.anchor.quote === 'string' ? thread.anchor.quote : null;
    const outcomes = await this.deps.waker.wake({
      cascade: { root: row.cascadeRoot, depth: row.cascadeDepth },
      trust,
      ...(writer.sessionId ? { authorSessionId: writer.sessionId } : {}),
      // An agent comment with no woken turn behind it is its own, spent cascade root.
      fromWokenTurn: row.cascadeRoot !== row.id,
      docKey: doc.key,
      targets,
      render: () =>
        renderCommentWake({
          docFolder: doc.space.root,
          docPath: doc.path,
          threadId: thread.id,
          quote,
          trigger: { authorName: writer.author.displayName, authorTrust: trust, body: row.body },
          earlier,
        }).text,
    });
    return outcomes.filter((outcome): outcome is UnreachedMention => !outcome.woken);
  }
}

/** A stored mention list; anything unreadable is no mentions. */
function parseMentions(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** An author nobody can find any more. */
function missingAuthor(id: string): DocCommentAuthor {
  return {
    id,
    kind: 'human',
    displayName: 'Someone',
    handle: null,
    emoji: null,
    color: null,
    isOwner: false,
  };
}

/** One stored thread as a reader sees it. */
function toThread(
  doc: DocLocation,
  { thread, comments }: StoredDocCommentThread,
  authors: ReadonlyMap<string, DocCommentAuthor>
): DocCommentThread {
  const author = (id: string) => authors.get(id) ?? missingAuthor(id);
  return {
    id: thread.id,
    path: doc.path,
    anchor: JSON.parse(thread.anchorJson) as DocCommentAnchor,
    resolved: thread.resolved,
    resolvedAt: thread.resolvedAt,
    resolvedBy: thread.resolvedByAuthorId ? author(thread.resolvedByAuthorId) : null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    comments: comments.map((comment): DocComment => ({
      id: comment.id,
      threadId: comment.threadId,
      author: author(comment.authorId),
      body: comment.body,
      mentions: parseMentions(comment.mentionsJson),
      trust: comment.trust,
      createdAt: comment.createdAt,
      editedAt: comment.editedAt,
    })),
  };
}
