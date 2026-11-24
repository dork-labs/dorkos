---
covers:
  - 'feat(api): community, cloud, hub and tunnel routes answer errors as problem documents (DOR-4979)'
---

### Changed

- More of the DorkOS API now answers errors in the standard `application/problem+json` format: connected spaces and their channels, the DorkOS account and hosted spaces, your own tunnel, hubs and their linked computers, and the agent computer. Each answer carries `code`, the kind of problem, and `detail`, a sentence about what went wrong. Errors no longer repeat a space's or a computer's own words, or the text of a failure (DOR-4979)

### Note for people upgrading

- **This is a breaking change for scripts that call these parts of the API directly.** The old `error` field is gone from their error answers: read `code` for the kind of problem and `detail` for the message. Codes are now lower case with underscores, and a few answers changed status, such as 412 instead of 409 or 410 when something changed since you looked. The DorkOS app already reads the new format. Every old code and its new name is in the [API reference](https://github.com/dork-labs/dorkos/blob/main/contributing/api-reference.md#codes-that-changed-spaces-the-dorkos-account-the-tunnel-hubs-and-the-agent-computer) (DOR-4979)
