/**
 * Doc comments as an agent works with them (DOR-2983): threads placed in the
 * doc's markdown as it is on disk now, and threads opened on raw markdown
 * ranges. Agents usually work with no editor open, so both go through the
 * headless anchors (`anchor-model.ts`), which place a thread exactly where the
 * editor would.
 *
 * @module services/docs/comments/comment-agent-view
 */
import fs from 'node:fs/promises';
import { anchorForRange, placeThreads } from './anchor-model.js';
import { DocCommentError } from './comment-errors.js';
import type { CommentWriteResult, CommentWriter, DocCommentService } from './comment-service.js';
import type { DocLocation } from './doc-location.js';

/** The longest raw span an agent is shown for one thread. */
const SPAN_TEXT_MAX = 2_000;

/** One thread, placed in the doc as it is now. */
export interface AgentThreadView {
  /** The thread's id. */
  id: string;
  /** Whether it is marked done. */
  resolved: boolean;
  /**
   * How it was found: `exact`, `moved`, `ambiguous` (another place fit as
   * well; check before acting on it), or `orphaned` (its words are gone).
   */
  match: 'exact' | 'moved' | 'ambiguous' | 'orphaned';
  /** The words the thread was opened on, as they were then. */
  quote: string | null;
  /**
   * Where the words are in the raw markdown now, `[start, end)` in
   * characters, with the markdown between them. `null` when the thread was
   * found but has no exact span (an escape, an entity, a wrapped paragraph,
   * code or frontmatter), or is orphaned.
   */
  span: { start: number; end: number; markdown: string } | null;
  /** Its comments, oldest first. */
  comments: Array<{ id: string; author: string; authorKind: string; body: string; at: string }>;
}

/** The doc's markdown, or a plain refusal when the file cannot be read. */
async function readMarkdown(doc: DocLocation): Promise<string> {
  try {
    return await fs.readFile(doc.file, 'utf8');
  } catch {
    throw new DocCommentError('NOT_FOUND', `There is no readable doc at ${doc.path}.`);
  }
}

/**
 * Every thread on a doc, placed in its markdown as it is on disk now.
 *
 * @param service - The comment service.
 * @param doc - The doc.
 */
export async function listThreadsForAgent(
  service: DocCommentService,
  doc: DocLocation
): Promise<AgentThreadView[]> {
  const threads = service.list(doc);
  if (threads.length === 0) return [];
  const markdown = await readMarkdown(doc);
  const placements = await placeThreads(
    markdown,
    new Map(threads.map((thread) => [thread.id, thread.anchor]))
  );
  return threads.map((thread) => {
    const placement = placements.get(thread.id) ?? { found: false as const };
    const source = placement.found ? placement.source : null;
    return {
      id: thread.id,
      resolved: thread.resolved,
      match: placement.found ? placement.match : 'orphaned',
      quote: typeof thread.anchor.quote === 'string' ? thread.anchor.quote : null,
      span: source
        ? {
            start: source.start,
            end: source.end,
            markdown: markdown.slice(source.start, source.end).slice(0, SPAN_TEXT_MAX),
          }
        : null,
      comments: thread.comments.map((comment) => ({
        id: comment.id,
        author: comment.author.displayName,
        authorKind: comment.author.isOwner ? 'owner' : comment.author.kind,
        body: comment.body,
        at: comment.createdAt,
      })),
    };
  });
}

/** What an agent is told when a range cannot be anchored. */
export const UNADDRESSABLE_RANGE_MESSAGE =
  'That range holds no text, or starts or ends inside text that can only be commented on ' +
  'whole: an escape such as snake\\_case, an entity such as &amp;, a paragraph wrapped over ' +
  'several lines, inline code, a code block or frontmatter. Widen it to whole words, lines or ' +
  'paragraphs and try again.';

/**
 * Open a thread on a raw markdown range of a doc, as the editor would from
 * that selection.
 *
 * @param service - The comment service.
 * @param doc - The doc.
 * @param writer - The agent, from its verified identity.
 * @param input - The range, `[start, end)` in characters, and the comment.
 * @throws DocCommentError `UNADDRESSABLE_RANGE` when the range cannot be anchored.
 */
export async function createThreadOnRange(
  service: DocCommentService,
  doc: DocLocation,
  writer: CommentWriter,
  input: { start: number; end: number; body: string }
): Promise<CommentWriteResult> {
  const markdown = await readMarkdown(doc);
  if (input.start < 0 || input.end > markdown.length || input.start >= input.end) {
    throw new DocCommentError(
      'UNADDRESSABLE_RANGE',
      `Give a range inside the doc: 0 <= start < end <= ${markdown.length}.`
    );
  }
  const anchor = await anchorForRange(markdown, input.start, input.end);
  if (!anchor) throw new DocCommentError('UNADDRESSABLE_RANGE', UNADDRESSABLE_RANGE_MESSAGE);
  return service.createThread(doc, writer, { anchor: { ...anchor }, body: input.body });
}
