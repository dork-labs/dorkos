---
covers:
  - 'feat(marketplace): reload a dev link when its folder changes (DOR-2696)'
  - "test(marketplace): pin the dev link watcher's classification, gate and sweep (DOR-2696)"
  - 'test(marketplace): prove the hot-reload Done when end to end, and the unlink hold (DOR-2696)'
  - "refactor(marketplace): split the dev link watcher's classification and extension seams into their own modules (DOR-2696)"
---

### Added

- A plugin or skill pack you run from a folder now picks up your edits within seconds (DOR-2696). Save a change to one of its extensions and DorkOS rebuilds it, without asking you again. Add a skill and it reaches your agent tools in that project. Changes to other files, like a README or your build output, reload nothing.
- Edits never approve anything new. A new extension, hook, server or program in the folder still asks you first, on its usual card.
- If you delete the folder, DorkOS stops reloading it and starts again within a minute of the folder coming back. After you unlink it, edits there do nothing.
