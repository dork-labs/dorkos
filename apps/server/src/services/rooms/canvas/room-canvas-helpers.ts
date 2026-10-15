import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { CanvasDocument } from '@dorkos/shared/room-schemas';
import type { UiCommand } from '@dorkos/shared/schemas';
import type { CanvasLedgerEntry, CanvasTreePlacement } from '../../canvas/index.js';

/**
 * The one line a person reads in the room's log for a whole turn's canvas work.
 *
 * Written for a person, not for a machine: the machine-readable half rides
 * `body.canvas` beside it. It names at most two documents and then counts the
 * rest, because a turn that opened six things should read as a sentence rather
 * than as a list.
 *
 * @param author - How the acting member is named.
 * @param ops - What the turn applied, oldest first.
 * @returns The sentence.
 */
export function canvasChangeSentence(author: string, ops: readonly CanvasLedgerEntry[]): string {
  const verbs = { opened: 'opened', updated: 'updated', closed: 'closed' } as const;
  const named = ops.slice(0, 2).map((op) => `${verbs[op.change]} ${op.title}`);
  const rest = ops.length - named.length;
  const list = named.join(' and ');
  return rest > 0
    ? `${author} ${list}, and changed ${rest} more thing${rest === 1 ? '' : 's'} on the canvas.`
    : `${author} ${list} on the canvas.`;
}

/**
 * The line the room reads when somebody starts a discussion about a document.
 *
 * Names the document by its own title, because that is what the person pressing
 * Discuss was looking at and what everybody else sees on the tab. The entry
 * heads the thread, so this sentence is the thing a reader clicks into.
 *
 * @param author - How the member who started it is named.
 * @param document - The document being discussed.
 * @returns The sentence.
 */
export function discussionOpenedSentence(
  author: string,
  document: Pick<CanvasDocument, 'title' | 'contentType'>
): string {
  const what = document.title.trim().length > 0 ? document.title : document.contentType;
  return `${author} started a discussion about ${what}.`;
}

/**
 * Whether one absolute directory sits inside another, or is it.
 *
 * A path comparison rather than a filesystem one, deliberately: it runs on every
 * open and must not touch the disk. The separator check is what stops
 * `/work/agent-two` reading as being inside `/work/agent`.
 *
 * @param child - The directory being tested.
 * @param parent - The directory it must be within.
 * @returns Whether `child` is `parent` or below it.
 */
/**
 * Name a room file by its path inside the tree it came out of (spec
 * `agent-home-desk` §5.6).
 *
 * A room turn stands in its agent's home and names a file in its copy of the
 * room's files — or in the room's shared checkout — by its FULL path. Every
 * reader of a room file document takes the stored path as relative to the
 * document's tree: the review refuses an absolute one, the merge reads `main`
 * at it, and the document key is built from it, so the same file opened twice
 * must name itself the same way. Anything that is not one of those two trees,
 * or that does not sit inside it, is left exactly as the agent wrote it.
 *
 * @param command - The command as the turn sent it.
 * @param tree - Where {@link RoomCanvasService.resolveTree} placed its file.
 */
export function withTreeRelativeSource(command: UiCommand, tree: CanvasTreePlacement): UiCommand {
  if (
    tree.resolvedCwd === null ||
    (tree.treeKind !== 'worktree' && tree.treeKind !== 'room-main')
  ) {
    return command;
  }
  const root = canonicalPath(tree.resolvedCwd);
  const relative = (source: string): string | null => {
    if (!path.isAbsolute(source)) return null;
    const rel = path.relative(root, canonicalPath(source));
    // Only a first SEGMENT of exactly `..` leaves the tree; `..notes.md` is a
    // file inside it (the same rule `canvas-diff-review.ts` applies).
    return rel === '' || rel.split(/[\\/]/)[0] === '..' || path.isAbsolute(rel) ? null : rel;
  };
  if ('sourcePath' in command && typeof command.sourcePath === 'string') {
    const rel = relative(command.sourcePath);
    return rel === null ? command : ({ ...command, sourcePath: rel } as UiCommand);
  }
  if ('content' in command && command.content && 'sourcePath' in command.content) {
    const source = command.content.sourcePath;
    const rel = typeof source === 'string' ? relative(source) : null;
    return rel === null
      ? command
      : ({ ...command, content: { ...command.content, sourcePath: rel } } as UiCommand);
  }
  return command;
}

/**
 * A path's real spelling: the real path of its deepest existing ancestor with
 * the rest appended, so a file that does not exist yet still compares by the
 * folder it would land in.
 */
export function canonicalPath(p: string): string {
  const resolved = path.resolve(p);
  try {
    return realpathSync.native(resolved);
  } catch {
    const parent = path.dirname(resolved);
    return parent === resolved
      ? resolved
      : path.join(canonicalPath(parent), path.basename(resolved));
  }
}

/** Test exact path equality or a slash-delimited descendant prefix. */
export function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const base = parent.endsWith('/') ? parent : `${parent}/`;
  return child.startsWith(base);
}
