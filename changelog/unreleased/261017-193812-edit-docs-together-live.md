---
covers:
  - 'feat(server): host live doc editing and merge agent writes into open docs (DOR-2984)'
  - 'feat(client): edit canvas docs live with people and agents, and restore a previous version (DOR-2984)'
  - "refactor(desktop): build the server's side bundles in their own module"
  - "fix(docs): never lose a person's live doc edits, and hold doc tools to the agent's folders (DOR-2984)"
  - 'fix(docs): keep live doc edits through reconnects, and pick the version to restore (DOR-2984)'
  - 'fix(docs): retry saves that meet a conflict, refuse unread writes, and survive a crash (DOR-2984)'
  - 'fix(docs): end reconnect loops, and offer back only edits the file does not have (DOR-2984)'
  - 'fix(docs): take changes on disk in whole, and count deletions as unsaved edits (DOR-2984)'
  - 'fix(docs): judge saved edits by snapshot, and stop waiting for a first sync that never comes (DOR-2984)'
---

### Added

- With the Docs experiment on, a markdown file open in the canvas is edited live: everyone with it open sees the same doc, with no saving step (DOR-2984)
- An agent's change to a doc you have open merges into it, so your unsaved typing stays (DOR-2984)
- Versions lists a doc's earlier versions, from before each agent change, so you can put one back, even after a reload (DOR-2984)
