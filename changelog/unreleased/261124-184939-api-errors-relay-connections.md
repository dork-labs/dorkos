---
covers:
  - 'feat(api): relay and connected-app routes answer errors as problem documents (DOR-4979)'
---

### Changed

- More of the DorkOS API now answers errors in the standard `application/problem+json` format: Relay messages and mailboxes, chat connections and chat routes, the webhook receivers, and connected apps (accounts, sign-in, access, notifications, spending, reviews and held actions). Each answer carries `code`, the kind of problem, and `detail`, a sentence about what went wrong (DOR-4979)

### Note for people upgrading

- **This is a breaking change for scripts that call these parts of the API directly.** The old `error` field is gone from their error answers: read `code` for the kind of problem and `detail` for the message. Codes are now lower case with underscores, and a few answers changed status, such as 412 instead of 409 when something changed since you looked. The DorkOS app and the `dorkos` command already read the new format. Every old code and its new name is in the [API reference](https://github.com/dork-labs/dorkos/blob/main/contributing/api-reference.md#codes-that-changed-relay-and-connected-apps) (DOR-4979)
