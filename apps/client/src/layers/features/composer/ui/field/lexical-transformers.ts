/**
 * The only markdown the composer's editor recognizes, as one closed array.
 *
 * **Closed on purpose, and built by naming rather than subtracting.** Spreading
 * `TRANSFORMERS` and removing what we do not want is how a link transformer
 * arrives silently in a minor version bump. Naming each one makes an addition a
 * diff someone has to approve.
 *
 * **What "not recognized" means, because it is not "not supported".** Excluding
 * a node from the editor does not remove the capability from the MESSAGE.
 * Unrecognized syntax stays as literal characters in the box, rides the wire as
 * the markdown it already is, and renders exactly as it does today through
 * `streamdown`. Someone who types a fenced code block gets a fenced code block
 * in the sent message; they just do not watch it become one while typing.
 *
 * **This array is the IMPORT half only.** It parses markdown into nodes and
 * drives the live typing shortcuts. The EXPORT half is
 * `markdown-offsets.ts`'s `$serializeWithOffsets`, deliberately not
 * `$convertToMarkdownString`: the stock serializer escapes every markdown
 * character it finds in a text node, so a typed `` ```code``` `` comes back as
 * `` \`\`\`code\`\`\` `` and a trailing `foo\` as `foo\\`. That would rewrite
 * what a person typed and break the promise in the paragraph above. Measured,
 * not assumed — see the round-trip corpus.
 *
 * **The constraint the round-trip test enforces:** a transformer that does not
 * round-trip cleanly is unusable however nice it looks, because the controlled
 * loop oscillates when `parse(md) → serialize()` is not a fixed point — the host
 * writes `V`, the editor emits `V'`, the host writes `V'`, and the caret is
 * destroyed on every keystroke.
 *
 * @module features/composer/ui/field/lexical-transformers
 */
import {
  BOLD_STAR,
  BOLD_UNDERSCORE,
  HEADING,
  INLINE_CODE,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  ORDERED_LIST,
  UNORDERED_LIST,
  type ElementTransformer,
  type Transformer,
} from '@lexical/markdown';
import type { TextFormatType } from 'lexical';

/**
 * Headings, capped at three levels.
 *
 * The stock `HEADING` transformer matches `#{1,6}`; the composer recognizes
 * `#`, `##` and `###` and nothing deeper, so `#### x` stays literal text. Only
 * the pattern is narrowed — the import and export halves are Lexical's own, so
 * this cannot drift from them in a version bump.
 */
const HEADING_H1_H3: ElementTransformer = { ...HEADING, regExp: /^(#{1,3})\s/ };

/**
 * How many transformers the composer recognizes.
 *
 * Asserted by the transformer test, so an accidental spread is caught by count
 * as well as by behaviour — a wrong count fails even if every named row still
 * happens to work.
 */
export const COMPOSER_TRANSFORMER_COUNT = 8;

/**
 * The only markdown the composer's editor recognizes.
 *
 * | Syntax | Result |
 * | --- | --- |
 * | `**bold**` · `__bold__` | text format `bold` (also `⌘B`) |
 * | `*italic*` · `_italic_` | text format `italic` (also `⌘I`) |
 * | `` `code` `` | text format `code` |
 * | `# ` `## ` `### ` | `HeadingNode` h1-h3 |
 * | `- ` `* ` `+ ` | `ListNode` unordered |
 * | `1. ` | `ListNode` ordered |
 * | `@handle` | `MentionNode` — NO transformer; it is a `TextNode` whose text
 *   is `@handle`, so it rides the ordinary text path |
 *
 * Deliberately NOT recognized: links (`[x](y)`), blockquotes (`> `), fenced
 * code blocks, strikethrough (`~~x~~`), horizontal rules, tables, images.
 * Fenced code has the strongest argument of the seven and still loses:
 * recognizing it would create a THIRD meaning for Enter, and the locked
 * decision authorized exactly one exception ("Enter continues a list").
 *
 * Bold sits before italic because the import scanner takes the first match and
 * `**x**` must not be read as two italic stars.
 */
export const COMPOSER_TRANSFORMERS: readonly Transformer[] = [
  HEADING_H1_H3,
  UNORDERED_LIST,
  ORDERED_LIST,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  INLINE_CODE,
];

/**
 * The two keyboard formats the composer offers, and only these two.
 *
 * No `⌘K`, because there are no links. Phase 3 registers these against
 * Lexical's `FORMAT_TEXT_COMMAND`; the list lives here so the shortcuts and the
 * transformer table can never disagree about what the editor understands.
 */
export const COMPOSER_TEXT_FORMAT_SHORTCUTS: readonly {
  readonly key: string;
  readonly format: TextFormatType;
}[] = [
  { key: 'b', format: 'bold' },
  { key: 'i', format: 'italic' },
];
