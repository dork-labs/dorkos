/**
 * Who gets a paste or a drop when the editor and the composer card both want it.
 *
 * The card already owns two drop-shaped behaviours that predate this work, and
 * the editor must DECLINE both rather than compete with them:
 *
 * - **Files.** `Composer.Root` owns an `onPaste` for attachments
 *   (`use-drag-and-paste.ts`), and DOR-947's room attachments are declared
 *   entirely by passing `onFilesDropped` to it. So any paste whose
 *   `clipboardData.items` contain a file is left to Root, which attaches it. A
 *   paste carrying BOTH files and HTML counts as a file paste, matching
 *   today's behaviour.
 * - **File-tree paths.** DOR-1032 added `usePathDrop` to the same module and
 *   wired it on both card variants; a dropped path becomes TEXT in the box, not
 *   an upload. Lexical registers its own `DROP_COMMAND` and `DRAGOVER_COMMAND`
 *   on the editable, so a path dropped directly on the field would be handled
 *   here before React's delegated `onDrop` at Root ever fired. Same rule: any
 *   drag carrying files or a file-path type is declined and bubbles.
 *
 * **Conversion is allowlist-shaped, not sanitizer-shaped.** A file-free paste
 * carrying HTML is parsed with `DOMParser` into an INERT document — never
 * inserted into the live DOM — walked, and mapped to the supported node set.
 * Anything outside that set contributes its `textContent` and nothing else. No
 * `dangerouslySetInnerHTML`, no `innerHTML` assignment, no `document.write`. A
 * pasted `<script>`, `<img onerror>` or `<iframe>` therefore cannot execute and
 * cannot survive as markup — it becomes text, or nothing.
 *
 * **How "leave it to Root" is spelled, and why not the obvious way.** These
 * handlers return Lexical's `true` — "consumed, stop" — and deliberately do NOT
 * call `preventDefault`. Returning `false` reads like the right answer and is
 * the wrong one: `@lexical/rich-text` registers its own `PASTE_COMMAND`,
 * `DROP_COMMAND` and `DRAGOVER_COMMAND` at `COMMAND_PRIORITY_EDITOR`, below us,
 * and its drop handler calls `event.preventDefault()` and dispatches
 * `DRAG_DROP_PASTE` for a file — so `false` hands the payload to Lexical
 * instead of to the card. A command's return value has nothing to do with DOM
 * propagation: `true` stops Lexical's chain, the event still bubbles, and
 * Root's `onPaste` / `onDrop` receive it exactly as they do today.
 *
 * No HTML is ever persisted, posted, or stored. What leaves the component is a
 * markdown string, the same string it is today.
 *
 * @module features/composer/ui/field/use-paste-precedence
 */
import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { mergeRegister } from '@lexical/utils';
import {
  $createParagraphNode,
  $createTextNode,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_CRITICAL,
  DRAGOVER_COMMAND,
  DROP_COMMAND,
  PASTE_COMMAND,
  type LexicalNode,
} from 'lexical';
import { hasFilePathDrag } from '@/layers/shared/lib';

/** Whether a clipboard payload carries at least one file. */
function carriesFile(data: DataTransfer | null): boolean {
  if (data === null) return false;
  if (data.files !== undefined && data.files.length > 0) return true;
  return Array.from(data.items ?? []).some((item) => item.kind === 'file');
}

/** Whether a drag belongs to the card rather than to the editor. */
function belongsToTheCard(data: DataTransfer | null): boolean {
  if (data === null) return false;
  if (carriesFile(data)) return true;
  return hasFilePathDrag(Array.from(data.types ?? []));
}

/** The inline HTML tags the composer's node set can represent. */
const INLINE_FORMAT_TAGS: Readonly<Record<string, 'bold' | 'italic' | 'code'>> = {
  B: 'bold',
  STRONG: 'bold',
  I: 'italic',
  EM: 'italic',
  CODE: 'code',
};

/** Tags whose entire subtree contributes nothing at all, not even text. */
const DROPPED_SUBTREES = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE']);

/** Block-level tags that start a new paragraph in the composer. */
const BLOCK_TAGS = new Set(['P', 'DIV', 'BR', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

/**
 * Turn an inert parsed document into the composer's own nodes.
 *
 * Allowlist-shaped: a tag is either in {@link INLINE_FORMAT_TAGS} (it applies a
 * format the composer has), or it is a block boundary, or it contributes only
 * its text. Nothing carries attributes across, so no event handler, `src`, or
 * `href` can survive the trip.
 *
 * @param html - The pasted `text/html`.
 * @returns Paragraph nodes ready to insert.
 */
function $nodesFromPastedHtml(html: string): LexicalNode[] {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const paragraphs: LexicalNode[] = [];
  let current = $createParagraphNode();

  const flush = () => {
    if (current.getChildrenSize() > 0) paragraphs.push(current);
    current = $createParagraphNode();
  };

  const walk = (node: Node, formats: ReadonlySet<'bold' | 'italic' | 'code'>) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? '';
      if (text.length === 0) return;
      const created = $createTextNode(text);
      for (const format of formats) created.toggleFormat(format);
      current.append(created);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const element = node as Element;
    if (DROPPED_SUBTREES.has(element.tagName)) return;

    const format = INLINE_FORMAT_TAGS[element.tagName];
    const nextFormats = format ? new Set([...formats, format]) : formats;
    const isBlock = BLOCK_TAGS.has(element.tagName);

    if (isBlock) flush();
    for (const child of Array.from(element.childNodes)) walk(child, nextFormats);
    if (isBlock) flush();
  };

  for (const child of Array.from(parsed.body.childNodes)) walk(child, new Set());
  flush();

  return paragraphs;
}

/** Register the paste and drop precedence rules on the composer's editor. */
export function usePastePrecedence(): void {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return mergeRegister(
      editor.registerCommand(
        PASTE_COMMAND,
        (event) => {
          // Duck-typed rather than `instanceof ClipboardEvent`: Lexical's
          // PASTE_COMMAND payload may be an InputEvent or KeyboardEvent, and
          // the constructor does not exist in every environment this runs in.
          const data =
            event !== null && 'clipboardData' in event
              ? ((event as { clipboardData: DataTransfer | null }).clipboardData ?? null)
              : null;

          // Left to the card, which attaches it. `true` keeps Lexical's own
          // handler off it; the DOM event still bubbles to Root's onPaste.
          if (carriesFile(data)) return true;
          if (data === null) return false;
          const pasteEvent = event as Event;

          // ⌘⇧V — the browser gives us text/plain only; nothing to convert.
          const html = data.getData('text/html');
          if (!html) return false;

          const nodes = $nodesFromPastedHtml(html);
          if (nodes.length === 0) return false;

          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return false;

          pasteEvent.preventDefault();
          selection.insertNodes(nodes);
          return true;
        },
        COMMAND_PRIORITY_CRITICAL
      ),

      editor.registerCommand(
        DROP_COMMAND,
        (event) => belongsToTheCard((event as DragEvent).dataTransfer),
        COMMAND_PRIORITY_CRITICAL
      ),

      editor.registerCommand(
        DRAGOVER_COMMAND,
        (event) => belongsToTheCard((event as DragEvent).dataTransfer),
        COMMAND_PRIORITY_CRITICAL
      )
    );
  }, [editor]);
}
