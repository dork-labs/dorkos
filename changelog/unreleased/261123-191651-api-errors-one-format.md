---
covers:
  - 'feat(api): the shared error answers are problem documents, and every client reads them (DOR-4979)'
  - 'fix(api): problem copy says something useful, and schema failures get their own code (DOR-4979)'
  - "fix(api): the chain never puts an exception's words on the wire (DOR-4979)"
---

### Changed

- The DorkOS API is moving all its error answers to one standard format, `application/problem+json`. This release switches the answers every route shares: a request that failed its checks, an address that does not exist, a request that is too large, and a server fault. Each carries `code`, the kind of problem (for example `not_found` or `request_too_large`), and `title`, a short summary. A request that failed its checks also says which field was wrong in `detail` and lists every field under `issues` (DOR-4979)
- Some of these answers now use a status that says whose mistake it was (DOR-4979):
  - Broken JSON is 400, not 500.
  - A body in an encoding or character set DorkOS can't read is 415, not 500.
  - A file over the upload limit on `/api/uploads` is 413, not 400.
  - A file type the upload settings don't allow on `/api/uploads` is 415, not 400.
  - A path with a null character in it is 400, not 403.

### Note for people upgrading

- **This is a breaking change for scripts that call the DorkOS API directly.** On the answers above, the old `error` field is gone: read `code` for the kind of problem, and `detail` (when present) or `title` for the message. A request that failed its checks is now `invalid_request`, and a body that could not be read at all is `malformed_request`. Field problems are listed under `issues` instead of `details`. The DorkOS app, the `dorkos` command and the desktop app already read the new format (DOR-4979)
