/**
 * Comment anchors without an editor (DOR-2983): where a thread's words are in
 * a doc's markdown, and an anchor for a raw markdown range, exactly as the
 * editor would place them. Agent tools read docs with no editor open, so they
 * go through here.
 *
 * ## One model per process, made on first use
 *
 * `createMarkdownModel()` (`blintz/collab`) is Blintz's headless document
 * model, the same one the editor uses. Measured on an M4 under Node 22:
 * importing `blintz/collab` and `@blintz/comments/core` takes about 330 ms the
 * first time, building the model about 5 ms, and resolving one anchor in a
 * short doc under 1 ms. So the one cost worth avoiding is the import: it is
 * deferred to the first call, kept off the server's start, and the model is
 * shared by every call after it. Resolving is cheap enough to run on the
 * request; no worker is needed.
 *
 * @module services/docs/comments/anchor-model
 */
import type { MarkdownModel } from 'blintz/collab';
import type { CommentAnchor, ResolvedAnchor } from '@blintz/comments/core';

/** The two headless calls this module uses, bound to the shared model. */
interface AnchorEngine {
  model: MarkdownModel;
  resolveAnchor: typeof import('@blintz/comments/core').resolveAnchor;
  createAnchor: typeof import('@blintz/comments/core').createAnchor;
}

let engine: Promise<AnchorEngine> | undefined;

/** The shared engine, imported and built on first use. A failed build is retried next time. */
function loadEngine(): Promise<AnchorEngine> {
  engine ??= (async () => {
    const [{ createMarkdownModel }, core] = await Promise.all([
      import('blintz/collab'),
      import('@blintz/comments/core'),
    ]);
    return {
      model: await createMarkdownModel(),
      resolveAnchor: core.resolveAnchor,
      createAnchor: core.createAnchor,
    };
  })().catch((err: unknown) => {
    engine = undefined;
    throw err;
  });
  return engine;
}

/** Where one thread's words are now. */
export type ThreadPlacement =
  /** Its words are gone or can't be found: the thread is orphaned. */
  | { found: false }
  | {
      found: true;
      /** How confidently it was found, as the editor reports it. */
      match: ResolvedAnchor['match'];
      /**
       * The raw markdown span its words came from, `[start, end)`, or `null`
       * when part of the text has no exact source (an escape, an entity, a
       * wrapped paragraph, code, frontmatter, a wiki link).
       */
      source: { start: number; end: number } | null;
    };

/**
 * Where each thread's words are in a doc's markdown now, parsing it once.
 *
 * @param markdown - The doc's markdown as it is on disk.
 * @param anchors - Each thread's stored anchor, by thread id.
 * @returns Each thread's placement, by thread id.
 */
export async function placeThreads(
  markdown: string,
  anchors: ReadonlyMap<string, unknown>
): Promise<Map<string, ThreadPlacement>> {
  const placements = new Map<string, ThreadPlacement>();
  if (anchors.size === 0) return placements;
  const { model, resolveAnchor } = await loadEngine();
  const source = model.source(markdown);
  for (const [threadId, anchor] of anchors) {
    const found = isCommentAnchor(anchor) ? resolveAnchor(model, source, anchor) : null;
    placements.set(
      threadId,
      found
        ? {
            found: true,
            match: found.match,
            source: found.source ? { start: found.source.start, end: found.source.end } : null,
          }
        : { found: false }
    );
  }
  return placements;
}

/**
 * An anchor for the text inside a raw markdown range, as the editor would make
 * it from that selection. Ends inside markup snap inward (`**bold**` anchors
 * `bold`).
 *
 * @param markdown - The doc's markdown.
 * @param start - Where the range starts (a character offset).
 * @param end - Where it ends, exclusive.
 * @returns The anchor, or `null` when no text lies inside the range or an end
 *   falls inside a run that can only be addressed whole.
 */
export async function anchorForRange(
  markdown: string,
  start: number,
  end: number
): Promise<CommentAnchor | null> {
  const { model, createAnchor } = await loadEngine();
  return createAnchor(model, markdown, start, end);
}

/**
 * Whether a stored anchor has the shape the headless resolver reads. The
 * store keeps any JSON object; a malformed one is treated as orphaned rather
 * than thrown on.
 */
function isCommentAnchor(value: unknown): value is CommentAnchor {
  if (typeof value !== 'object' || value === null) return false;
  const anchor = value as Record<string, unknown>;
  return (
    typeof anchor.quote === 'string' &&
    typeof anchor.prefix === 'string' &&
    typeof anchor.suffix === 'string' &&
    typeof anchor.start === 'number' &&
    typeof anchor.end === 'number'
  );
}
