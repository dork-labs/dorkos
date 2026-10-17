---
covers:
  - 'feat(server): host live doc editing and merge agent writes into open docs (DOR-2984)'
  - 'feat(client): edit canvas docs live with people and agents, and restore a previous version (DOR-2984)'
  - "refactor(desktop): build the server's side bundles in their own module"
  - "fix(docs): never lose a person's live doc edits, and hold doc tools to the agent's folders (DOR-2984)"
---

### Added

- With the Docs experiment on, a markdown file open in the canvas is edited live: everyone with it open sees the same doc, with no saving step (DOR-2984)
- An agent's change to a doc you have open merges into it, so your unsaved typing stays (DOR-2984)
- Restore previous version puts a doc back as it was before an agent's change, even after a reload (DOR-2984)
