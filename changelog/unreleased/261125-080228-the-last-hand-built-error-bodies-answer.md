---
covers:
  - 'feat(api): the last hand-built error bodies answer problem documents (DOR-4979)'
  - 'refactor(server): delete errorBody and toErrorMessage, the old error-shape helpers (DOR-4979)'
  - 'refactor(api): the app, CLI and desktop read problem documents only (DOR-4979)'
  - 'fix(api): review round 1 on the last error bodies (DOR-4979)'
---

### Changed

- Every error the DorkOS API sends now has one shape, with a few deliberate exceptions: a standard "problem" answer with a `code` and a sentence in `detail`. The last few that still used the old `{ "error": "…" }` shape have moved over. A script or integration that read `error` from an answer should read `code` and `detail` instead. The app and the `dorkos` command already read the new shape. The full list of changed codes is in the API reference.
