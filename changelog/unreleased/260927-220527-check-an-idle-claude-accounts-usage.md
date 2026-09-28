---
covers:
  - "feat(server): check an idle Claude account's usage without running a turn (DOR-2381)"
---

### Added

- DorkOS can now check how much of a Claude Code account is used even when nobody has worked on it lately. It starts Claude Code on that account with nothing to answer, reads the usage, and closes it again, so nothing is billed and no chat is saved. Your agents can ask for it with the new `accounts_probe` tool. Each account is checked at most once a minute, and a check that cannot read anything leaves the account marked as unknown rather than guessing (DOR-2381).
