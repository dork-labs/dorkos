# Design Decisions — rich text in the composer (Lexical)

Visual companion session: `.dork/visual-companion/81863-1786054606/` (2026-08-06, with Dorian)

## 1. Editing feel

**Screen:** `rich-text-editing-feel.html`
**Options:** A) invisible editor — markdown shortcuts only, zero chrome · B) shortcuts + floating toolbar on selection · C) persistent toolbar row
**Chosen:** **A — the invisible editor.** Live markdown conversion as you type (`**bold**`, `*italic*`, `# heading`, `- list`), keyboard combos (⌘B/⌘I), no toolbar of any kind. The composer looks exactly like today until text starts formatting itself.

## 2. Mentions while typing

**Screen:** `mention-in-editor-look.html`
**Options:** A) the real identity pill live in the editor · B) quiet tinted `@handle`, pill on send
**Chosen:** **A — the real pill, live in the editor.** After the `@` typeahead resolves, the mention renders as the same identity-colored, glyph-bearing pill the sent message shows; it behaves as one atomic unit (backspace deletes the whole pill). Full WYSIWYG.

## Open items for SPECIFY (recommendations, not yet decided)

- **Paste:** recommend converting pasted rich text to markdown (fits the WYSIWYG-with-markdown-wire model); plain-text paste via the standard modifier. Not yet confirmed by Dorian.
- **Enter semantics in block contexts:** recommend Enter-to-send stays global; inside a list, Enter continues the list and an empty list item exits it (the common convention that preserves send-muscle-memory). Not yet confirmed by Dorian.
- Locked architecture (2026-08-03, not revisited): Lexical WYSIWYG, Tiptap fallback, markdown on the wire, one `LexicalTypeaheadMenuPlugin` for `@` and `/`, phased behind a flag.

## Final Design Summary

The Lexical editor must be visually indistinguishable from today's textarea at rest: no chrome, no toolbar, no persistent affordances. Formatting exists only through live markdown shortcut conversion and keyboard combos. Mentions are first-class editor nodes rendering the shipped `MentionPill` styling inline, atomic on delete, serialized to `@handle` markdown on send (the server still resolves addressing at write time — the editor never becomes the resolver). The flag-off textarea path stays byte-identical in behavior until the editor graduates.
