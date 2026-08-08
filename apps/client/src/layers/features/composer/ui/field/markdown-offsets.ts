/**
 * The markdown boundary: the document as a markdown string, and the map from
 * that string's offsets back to the nodes that produced them.
 *
 * This is the load-bearing module of the whole spec. Every one of the four
 * directions the host contract needs goes through it.
 *
 * **Why a map at all.** Serialization is not identity: `**bold**` adds four
 * characters that belong to no text node, a `- ` marker is written but was
 * never typed, and a mention contributes `@handle` from a node whose DOM is a
 * pill. Deriving the caret from `textContent` alone would put the `@`-trigger
 * regex a few characters off exactly when someone is mid-formatting — which is
 * to say, exactly when the palette matters.
 *
 * **Why ONE walk.** Two walks are two chances to disagree, and the disagreement
 * would show up as a caret that drifts only in documents with formatting. The
 * string and the map are built together or not at all.
 *
 * **Why this and not `$convertToMarkdownString`.** The stock serializer escapes
 * every markdown character it finds in a text node. Measured against Lexical
 * 0.49: a trailing `foo\` comes back as `foo\\`, a typed fenced code block as
 * `` \`\`\`code\`\`\` ``, `~~strike~~` as `\~\~strike\~\~`, and `2 ** 3` as
 * `2 \*\* 3`. Every one of those is text a person typed, silently rewritten,
 * and two of them are load-bearing elsewhere: the backslash-continuation rung
 * depends on `foo\` surviving, and the whole "unrecognized syntax stays literal
 * and renders through streamdown" promise depends on the other three. So the
 * composer writes its own markdown and escapes nothing.
 *
 * The cost of not escaping, stated so it is a decision and not an oversight: a
 * text node holding a literal `**x**` would serialize to `**x**` and re-parse
 * as bold. That state is not reachable through the editor — typing `**x**`
 * fires the markdown shortcut and produces a bold node, and hydrating `**x**`
 * parses it as bold — so the trade is a reachable class of silent rewrites
 * against an unreachable one.
 *
 * **The fixed-point invariant.** For every value a host can write back,
 * `parse(md) → serialize()` must equal `md` exactly. If it does not, the
 * controlled loop oscillates — the host writes `V`, the editor emits `V'`, the
 * host writes `V'`, and the caret is destroyed on every keystroke. The
 * round-trip corpus is the gate on that.
 *
 * **The hosts this contract serves**, named so a future reader knows what
 * breaks. None of them is modified by this spec — that is the whole point of
 * preserving the units:
 *
 * - `features/chat/model/use-input-autocomplete.ts` runs
 *   `detectFileTrigger(value, cursor)` / `detectCommandTrigger`
 * - `features/mentions/model/use-mention-autocomplete.ts` matches
 *   `MENTION_TRIGGER` against `text.slice(0, cursorPos)` and writes back through
 *   `insertMention`, which slices by the same offsets
 * - `widgets/room-view/ui/RoomComposer.tsx` then calls `focusAt(cursorPos)`
 * - `features/chat/ui/input/ChatInputContainer.tsx`'s `insertIntoComposer`
 *   calls `focusAt(next.length)` after a file-tree path drop
 *
 * @module features/composer/ui/field/markdown-offsets
 */
import { $isListItemNode, $isListNode } from '@lexical/list';
import { $isHeadingNode } from '@lexical/rich-text';
import {
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  type ElementNode,
  type LexicalNode,
  type NodeKey,
  type TextNode,
} from 'lexical';

/**
 * One node's contribution to the markdown string.
 *
 * Named for readability rather than exported: the spec declares `spans` with an
 * inline type, and nothing outside this module needs to say the name.
 */
interface ComposerDocSpan {
  /** The node that produced this run. */
  readonly key: NodeKey;
  /** Index in `markdown` where the run starts. */
  readonly start: number;
  /** Index in `markdown` just past the run's last character. */
  readonly end: number;
  /** Offset within the node's own text that `start` corresponds to. */
  readonly textOffset: number;
}

/** A markdown string and the map from its offsets back to the document. */
export interface SerializedComposerDoc {
  readonly markdown: string;
  /** Each entry: a Lexical node key, and the [start, end) run of `markdown` it produced. */
  readonly spans: readonly ComposerDocSpan[];
}

/**
 * The formats this serializer writes marks for, outermost first.
 *
 * The order is the canonical nesting: bold outside italic outside code, so the
 * same set of formats always produces the same string. Lexical's remaining
 * format bits (strikethrough, subscript, …) have no transformer in the
 * composer's closed set, so nothing can create them and nothing writes them.
 */
const MARKS: readonly { readonly bit: number; readonly mark: string }[] = [
  { bit: 1, mark: '**' },
  { bit: 2, mark: '*' },
  { bit: 16, mark: '`' },
];

/** The blank line between two top-level blocks. */
const BLOCK_SEPARATOR = '\n\n';

/** The markdown prefix a block contributes before its own text. */
function blockPrefix(node: ElementNode, itemNumber: number): string {
  if ($isHeadingNode(node)) return '#'.repeat(Number(node.getTag().slice(1))) + ' ';
  if ($isListItemNode(node)) {
    const list = node.getParent();
    return $isListNode(list) && list.getListType() === 'number' ? `${itemNumber}. ` : '- ';
  }
  return '';
}

/** Accumulates the string and the spans in step with each other. */
class DocWriter {
  private out = '';
  private readonly collected: ComposerDocSpan[] = [];

  /** Append syntax that belongs to no node — marks, prefixes, separators. */
  syntax(text: string): void {
    this.out += text;
  }

  /** Append a node's own text, recording the run it occupies. */
  text(node: TextNode, value: string): void {
    const start = this.out.length;
    this.out += value;
    this.collected.push({ key: node.getKey(), start, end: this.out.length, textOffset: 0 });
  }

  /**
   * Record a zero-width anchor for an element, so a caret parked on an empty
   * block (or between children) still maps to a markdown offset.
   */
  anchor(node: LexicalNode): void {
    this.collected.push({
      key: node.getKey(),
      start: this.out.length,
      end: this.out.length,
      textOffset: 0,
    });
  }

  /** The finished document. */
  finish(): SerializedComposerDoc {
    return { markdown: this.out, spans: this.collected };
  }
}

/**
 * Write one block's inline children.
 *
 * Marks are emitted on TRANSITIONS rather than per node, because Lexical splits
 * a formatted run into one text node per distinct format: `**a `c` b**` arrives
 * as three nodes (bold, bold+code, bold). Opening and closing per node would
 * write `**a ****`c`**** b**` — still parseable, but not what anyone typed.
 * Keeping a stack and moving only the difference writes the original back.
 */
function writeInline(writer: DocWriter, block: ElementNode): void {
  writer.anchor(block);

  /** Format bits currently open, outermost first. */
  let open: number[] = [];

  /** Close down to `depth`, innermost first. */
  const closeTo = (depth: number) => {
    while (open.length > depth) {
      const bit = open.pop()!;
      writer.syntax(MARKS.find((entry) => entry.bit === bit)!.mark);
    }
  };

  for (const child of block.getChildren()) {
    if ($isLineBreakNode(child)) {
      // Marks never span a hard break: `**a**\n**b**` re-parses to exactly the
      // nodes that produced it, where `**a\nb**` would not.
      closeTo(0);
      writer.syntax('\n');
      continue;
    }

    const format = $isTextNode(child) ? child.getFormat() : 0;
    const desired = MARKS.filter((entry) => (format & entry.bit) !== 0).map((entry) => entry.bit);

    let shared = 0;
    while (shared < open.length && shared < desired.length && open[shared] === desired[shared]) {
      shared += 1;
    }
    closeTo(shared);
    for (const bit of desired.slice(shared)) {
      writer.syntax(MARKS.find((entry) => entry.bit === bit)!.mark);
      open.push(bit);
    }

    if ($isTextNode(child)) writer.text(child, child.getTextContent());
    else writer.syntax(child.getTextContent());
  }

  closeTo(0);
  open = [];
}

/** Write one top-level block, or a list's items. */
function writeBlock(writer: DocWriter, node: LexicalNode): void {
  if ($isListNode(node)) {
    const items = node.getChildren();
    let number = node.getStart();
    items.forEach((item, itemIndex) => {
      if (itemIndex > 0) writer.syntax('\n');
      if ($isElementNode(item)) {
        writer.syntax(blockPrefix(item, number));
        writeInline(writer, item);
      }
      number += 1;
    });
    return;
  }

  if (!$isElementNode(node)) {
    writer.syntax(node.getTextContent());
    return;
  }

  writer.syntax(blockPrefix(node, 1));
  writeInline(writer, node);
}

/**
 * Serialize the document and build its position map in a single walk.
 *
 * Must run inside `editor.read()` or `editor.update()`.
 *
 * @returns The markdown and the spans that produced it.
 */
export function $serializeWithOffsets(): SerializedComposerDoc {
  const writer = new DocWriter();
  const blocks = $getRoot().getChildren();

  blocks.forEach((block, index) => {
    if (index > 0) writer.syntax(BLOCK_SEPARATOR);
    writeBlock(writer, block);
  });

  return writer.finish();
}

/**
 * The caret's offset into `doc.markdown`.
 *
 * `null` when the selection is not a single collapsed caret — a range, a node
 * selection, or nothing focused. The field treats `null` as "do not emit a
 * cursor change" rather than as offset 0, because reporting 0 would make the
 * mention and command detectors match against the start of the document.
 *
 * Must run inside `editor.read()` or `editor.update()`.
 *
 * @param doc - The document {@link $serializeWithOffsets} produced.
 * @returns The offset, or `null`.
 */
export function $markdownOffsetOfSelection(doc: SerializedComposerDoc): number | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;

  const anchor = selection.anchor;
  const span = doc.spans.find((candidate) => candidate.key === anchor.key);
  if (span === undefined) return null;

  if (anchor.type === 'element') return span.start;

  const within = anchor.offset - span.textOffset;
  return Math.min(Math.max(span.start + within, span.start), span.end);
}

/**
 * Put a collapsed caret at markdown offset `pos`.
 *
 * The inverse of {@link $markdownOffsetOfSelection}. An offset that lands
 * inside syntax the document did not type — between the asterisks of `**`, or
 * on a list marker — has no node to sit in, so the caret goes to the nearest
 * position a person could have reached.
 *
 * Must run inside `editor.update()`.
 *
 * @param doc - The document {@link $serializeWithOffsets} produced.
 * @param pos - An offset into `doc.markdown`.
 */
export function $selectMarkdownOffset(doc: SerializedComposerDoc, pos: number): void {
  const textSpans = doc.spans.filter((span) => span.end > span.start);
  const spans = textSpans.length > 0 ? textSpans : doc.spans;
  if (spans.length === 0) {
    $getRoot().selectEnd();
    return;
  }

  // The last span that starts at or before `pos`, so a caret at the end of a
  // run stays in that run rather than jumping into the next one.
  let chosen = spans[0];
  for (const span of spans) {
    if (span.start <= pos) chosen = span;
  }

  const node = $getNodeByKey(chosen.key);
  if (node === null) {
    $getRoot().selectEnd();
    return;
  }

  const within = Math.min(Math.max(pos - chosen.start, 0), chosen.end - chosen.start);
  const offset = chosen.textOffset + within;

  if ($isTextNode(node)) {
    node.select(offset, offset);
    return;
  }
  if ($isElementNode(node)) {
    node.selectStart();
    return;
  }
  $getRoot().selectEnd();
}
