---
covers:
  - 'feat(server): keep usage per account in the shared ledger and serve it over REST, MCP and events (DOR-2380)'
---

### Added

- DorkOS now keeps track of how much of each Claude Code account you have used, across every session on that account, and remembers it after a restart. Your agents can read it with the new `accounts_usage` tool. It includes this computer's own Claude sign-in, even when you have registered other accounts, and it shares one record per account with the `flow` command (DOR-2380)

### Fixed

- Starting work on the `default` account now uses this computer's own Claude sign-in, even when DorkOS itself was started from a terminal pointed at a different account. If one of your accounts used to be called `default`, the agents and schedules that named it move to its new name and keep using it. Schedules that come from an installed package are not changed (DOR-2380)
