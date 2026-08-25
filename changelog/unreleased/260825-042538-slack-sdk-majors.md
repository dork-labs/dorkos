---
covers:
  - 'chore(deps): Slack SDK majors — bolt 5, web-api 8 (DOR-1528)'
---

### Changed

- The Slack connection now runs on the latest Slack toolkit (Bolt 5 and Web API 8). Slack rebuilt how these send requests, moving to the networking that is already built into Node, so there is one less library underneath your Slack rooms. Nothing changes in how you set Slack up or use it (DOR-1528)

### Fixed

- When your Slack token stops working — you removed the app, the token was revoked, or it never had the right permissions — the Slack connection now stops and tells you so. It used to miss that the problem was fatal and keep retrying forever against a token that was never going to work again, leaving the connection quietly stuck instead of reporting the error you needed to see (DOR-1528)
