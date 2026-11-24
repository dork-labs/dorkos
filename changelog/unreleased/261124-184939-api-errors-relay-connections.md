---
covers:
  - 'feat(api): relay and connected-app routes answer errors as problem documents (DOR-4979)'
  - 'fix(api): review round 1 on the relay and connection problems (DOR-4979)'
  - 'fix(api): review round 2 on the relay and connection problems (DOR-4979)'
---

### Changed

- When a new chat connection is saved but can't connect, the app still links it to your agent and asks you to check its token, instead of suggesting you add it again (DOR-4979)
- More of the DorkOS API now answers errors in the standard `application/problem+json` format: Relay messages and mailboxes, chat connections and chat routes, the webhook receivers, and connected apps (accounts, sign-in, access, notifications, spending, reviews and held actions). Each answer carries `code`, the kind of problem, and `detail`, a sentence about what went wrong (DOR-4979)

### Note for people upgrading

- **This is a breaking change for scripts that call these parts of the API directly.** The old `error` field is gone from their error answers: read `code` for the kind of problem and `detail` for the message. Codes are now lower case with underscores, and a few answers changed status, such as 412 instead of 409 when something changed since you looked. A refused connection setting now names the settings to fix in `fields`, and a webhook whose signed body isn't JSON gets 400 instead of 401. The DorkOS app and the `dorkos` command already read the new format. Every old code and its new name is in the [API reference](https://github.com/dork-labs/dorkos/blob/main/contributing/api-reference.md#codes-that-changed-relay-and-connected-apps) (DOR-4979)
