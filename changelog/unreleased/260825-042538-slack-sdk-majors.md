---
covers:
  - 'chore(deps): Slack SDK majors — bolt 5, web-api 8 (DOR-1528)'
  - 'fix(relay): a revoked Slack token actually stops the adapter (DOR-1528)'
---

### Changed

- The Slack connection now runs on the latest Slack toolkit (Bolt 5 and Web API 8). Setting up and using Slack is unchanged (DOR-1528)

### Fixed

- When your Slack token stops working — you removed the app, the token was revoked, or it never had the right permissions — the Slack connection now stops and tells you which problem it hit. It used to miss that the failure was permanent and keep retrying forever against a token that was never going to work again, so the connection sat there looking busy while every message quietly went nowhere. It also now shuts down cleanly, instead of leaving background timers running against the dead connection (DOR-1528)
