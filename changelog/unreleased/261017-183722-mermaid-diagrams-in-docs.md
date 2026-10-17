---
covers:
  - 'feat(client): upgrade to blintz 0.8.0 and draw mermaid diagrams in canvas docs'
  - 'fix(docs): key a doc by the file it resolves to, and keep Docs off /api/docs'
---

### Added

- Mermaid diagrams now draw in markdown documents on the canvas. The diagram code loads only when a document has one.

### Changed

- In canvas documents, `[[Page name]]` now shows as a link, and a line that is only `::name` shows as a placeholder block. Both are kept exactly as written when you save. Write `\::name` to keep such a line as plain text.
- Tables you add while editing a document are saved without column alignment marks (`| - |` instead of `| :- |`).
- Undo no longer reverses a change that arrived from outside the editor, such as an agent rewriting the file. Your own edits still undo as before.
