---
covers:
  - 'feat(api): the shared error answers are problem documents, and every client reads them (DOR-4979)'
---

### Changed

- The DorkOS API is moving all its error answers to one standard format, `application/problem+json`. This release switches the answers every route shares: a request that failed its checks, an address that does not exist, a request that is too large, and a server fault. Each one now says what went wrong in `detail` and what kind of problem it is in `code` (for example `not_found` or `request_too_large`) (DOR-4979)
- Broken JSON sent to the API is now answered as the sender's mistake (400), not as a server fault (500) (DOR-4979)

### Note for people upgrading

- **This is a breaking change for scripts that call the DorkOS API directly.** On the answers above, the old `error` field is gone: read `detail` for the message and `code` for the kind of problem. Validation problems list each field's trouble under `issues` instead of `details`. The DorkOS app, the `dorkos` command and the desktop app already read the new format (DOR-4979)
