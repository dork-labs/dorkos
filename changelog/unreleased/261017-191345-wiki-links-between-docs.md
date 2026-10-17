---
covers:
  - 'feat(shared): one set of wiki-link rules for the docs in a space (DOR-2982)'
  - 'feat(server): list the docs in a space for wiki links, behind the Docs experiment (DOR-2982)'
  - 'feat(server): read a doc title the way one-line YAML frontmatter writes it (DOR-2982)'
  - 'feat(server): answer 400 for a doc space that is not an existing folder (DOR-2982)'
  - 'feat(client): wiki links and the [[ menu in canvas docs, behind the Docs experiment (DOR-2982)'
  - 'fix(docs): give every doc index request a fresh walk, time-boxed, reading titles through one handle (DOR-2982)'
  - 'fix(docs): look a link up across the whole space when the doc index is truncated (DOR-2982)'
  - 'fix(docs): show a link as missing only when it is, and re-read the index only when a save changes a title (DOR-2982)'
  - 'fix(docs): say exactly when a missing link starts working (DOR-2982)'
---

### Added

- Markdown docs on the canvas can now link to each other, behind the new **Docs** experiment in Settings → Advanced → Experiments. Type `[[` to pick another doc from your chat's folder, or write a doc's title or file name between double brackets. Clicking a link opens that doc in the canvas. A link to a doc that doesn't exist yet looks different. It starts working the next time DorkOS reads the folder's docs: after you create or rename a file in the Files panel, save a doc with a new title, or come back to the DorkOS window.
