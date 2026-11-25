---
covers:
  - 'feat(api): the last route groups answer errors as problem documents (DOR-4979)'
  - 'fix(api): review round 1 on the last route groups (DOR-4979)'
---

### Changed

- The rest of the DorkOS API now answers errors in the standard `application/problem+json` format: approvals, permissions, to-do promises, first-run setup, the harness, feedback, push devices, admin restart and reset, commands and models, the docs links, the browser viewer, and the address and remote access checks. Each answer carries `code`, the kind of problem, and `detail`, a sentence about what went wrong (DOR-4979)

### Note for people upgrading

- **This is a breaking change for scripts that call these parts of the API directly.** The old `error` field is gone from their error answers: read `code` for the kind of problem and `detail` for the message. Codes are now lower case with underscores, and a few answers changed status, such as 412 instead of 409 when an Undo meets a setting that changed since. The DorkOS app and the `dorkos` command already read the new format. Every old code and its new name is in the [API reference](https://github.com/dork-labs/dorkos/blob/main/contributing/api-reference.md#codes-that-changed-the-last-route-groups) (DOR-4979)
