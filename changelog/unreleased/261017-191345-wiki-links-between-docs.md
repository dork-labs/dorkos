---
covers:
  - 'feat(shared): one set of wiki-link rules for the docs in a space (DOR-2982)'
  - 'feat(server): list the docs in a space for wiki links, behind the Docs experiment (DOR-2982)'
  - 'feat(client): wiki links and the [[ menu in canvas docs, behind the Docs experiment (DOR-2982)'
---

### Added

- Markdown docs on the canvas can now link to each other, behind the new **Docs** experiment in Settings → Advanced → Experiments. Type `[[` to pick another doc from your chat's folder, or write a doc's title or file name between double brackets. Clicking a link opens that doc in the canvas. A link to a doc that doesn't exist yet looks different until the doc is there.
