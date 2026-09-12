/**
 * What a member may see of one document on a room's table (spec `room-canvas`
 * §8, §8.1).
 *
 * A document on a shared table is not a way to read a tree you could not already
 * read. Most shapes carry what they show in the row itself, so every member sees
 * the same thing and there is nothing to decide. The exception is a document
 * that names a FILE: its bytes stay where they are, and which tree the path was
 * resolved against — recorded when it was opened, never re-derived — is what
 * decides who can open it.
 *
 * - `room-main`: the room's own shared copy. Every member can already read it,
 *   and the room's files route is how they do — the same read and the same
 *   attributed save the Room tab's Files section takes.
 * - `worktree` / `agent-cwd`: one member's own working copy, or their own
 *   project in a room that has no files of its own. **This app has no route into
 *   either**, so the tab shows what the row knows — the name, the line saying
 *   whose copy it is — and one plain sentence about why the contents are not
 *   here.
 *
 * The check is on the READER at the moment they look, not on the writer when the
 * document was opened, so it holds for somebody who joined afterwards.
 *
 * @module features/canvas/lib/room-canvas-reading
 */
import type { CanvasDocument } from '@dorkos/shared/room-schemas';
import type { UiCanvasContent } from '@dorkos/shared/types';

/** What a viewer gets when they open one document on a room's table. */
export type RoomDocumentReading =
  /** Draw it from the row — everything it shows travelled with it. */
  | { kind: 'inline' }
  /** A text file in the room's own shared copy: read and save it through the room's files. */
  | { kind: 'room-file'; sourcePath: string }
  /**
   * An agent's working copy of the room's files, ahead of the room — review it
   * against `main`, and merge it (spec `canvas-agent-seat` §8).
   *
   * The one document on a room's table that is about a DECISION rather than
   * about reading something, which is why it is its own answer: the tree is the
   * room's own working copy, DorkOS made it, and the row records exactly which
   * one — so a reject lands where the work is instead of being re-derived.
   */
  | {
      kind: 'worktree-diff';
      sourcePath: string;
      cwd: string;
      content: Extract<UiCanvasContent, { type: 'diff' }>;
    }
  /** Somewhere this app has no route to: draw the card and say this. */
  | { kind: 'elsewhere'; sourcePath: string; sentence: string };

/** Media shapes whose `src` may be a local path instead of a URL. */
const MEDIA_TYPES = ['image', 'pdf', 'audio', 'video', 'csv', 'model3d'] as const;

/** Whether a media `src` is something a browser can fetch on its own. */
function isRemote(src: string): boolean {
  return /^(https?:|data:)/.test(src);
}

/**
 * The file a document names, or null when its content travelled in the row.
 *
 * `file` and `diff` are a path and nothing else. `markdown` carries its text AND
 * may name the file it was read from, which is what earns it the source editor
 * rather than the rich one (§10). Media names a path only when its `src` is not
 * a URL the browser could fetch by itself.
 */
function pathOf(content: UiCanvasContent): string | null {
  if (content.type === 'file' || content.type === 'diff') return content.sourcePath;
  if (content.type === 'markdown') return content.sourcePath ?? null;
  if ((MEDIA_TYPES as readonly string[]).includes(content.type)) {
    const src = (content as { src: string }).src;
    return isRemote(src) ? null : src;
  }
  return null;
}

/**
 * Whether a path names something the room's files route can hand back as text.
 *
 * That route serves file CONTENTS, so a picture or a recording in the room's own
 * copy is still not something this tab can draw — it gets the card, with a
 * sentence pointing at the place that can show it.
 */
function isTextDocument(content: UiCanvasContent): boolean {
  return content.type === 'file' || content.type === 'diff' || content.type === 'markdown';
}

/**
 * Whose copy the document is in, for the sentence — taken from the line the
 * server already wrote rather than guessed.
 *
 * `sourceLabel` reads "Ana's copy · 3 ahead of main" or "in Ana's project", so
 * the name is the part before the possessive. With no label to read, the
 * sentence says "another member": naming the wrong person is worse than naming
 * nobody.
 */
function ownerOf(document: CanvasDocument): string {
  const owned = /^(?:in )?(.+?)['’]s /.exec(document.sourceLabel ?? '');
  return owned?.[1] ?? 'another member';
}

/**
 * What this viewer may do with one document on a room's table.
 *
 * @param document - The document, as the room's table holds it.
 * @returns Draw it from the row, read it through the room's files, or say where
 *   it is and why it is not here.
 */
export function roomDocumentReading(document: CanvasDocument): RoomDocumentReading {
  const sourcePath = pathOf(document.content);
  if (sourcePath === null) return { kind: 'inline' };

  // No tree recorded means nobody was standing anywhere when it was opened,
  // which is exactly what a PERSON's open through the Room tab's Files section
  // produces: that request carries no working directory, and the only files a
  // person browses in a room are the room's own. Reading it that way is also the
  // safe way round — the room's files route is membership-gated and confined to
  // the room's own checkout, so the worst a wrong guess can do is fail to find
  // the file.
  if (document.treeKind === 'room-main' || document.treeKind === undefined) {
    if (isTextDocument(document.content)) return { kind: 'room-file', sourcePath };
    return {
      kind: 'elsewhere',
      sourcePath,
      sentence:
        'This file is in the room’s own files. Open it from the Files section of the Room tab.',
    };
  }

  // **A diff from a working copy that is ahead of the room is a review, not a
  // card** (spec `canvas-agent-seat` §8). Three things have to be true together
  // and each rules something out: the tree is a room worktree, so DorkOS made it
  // and the row carries the directory; the copy is measurably ahead, so there is
  // something to decide (`null` means nobody asked, which is not the same as
  // level and must not be shown as one); and the row actually recorded the
  // directory, which only a `worktree` row does.
  if (
    document.content.type === 'diff' &&
    document.treeKind === 'worktree' &&
    typeof document.aheadOfMain === 'number' &&
    document.aheadOfMain > 0 &&
    document.resolvedCwd !== undefined
  ) {
    return {
      kind: 'worktree-diff',
      sourcePath,
      cwd: document.resolvedCwd,
      content: document.content,
    };
  }

  // Markdown's text came with the row, so it still draws for everybody. What it
  // does not get is an editor: the file it was read from is in a tree this app
  // can neither read nor write.
  if (document.content.type === 'markdown') return { kind: 'inline' };

  return {
    kind: 'elsewhere',
    sourcePath,
    sentence: `This file is in ${ownerOf(document)}’s project, which you can’t open from here. Ask them to share it, or open your own copy.`,
  };
}
