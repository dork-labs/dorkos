---
covers:
  - 'feat(settings): show usage for every runtime and let each Claude account pick its color (DOR-2379)'
---

### Added

- Settings → Runtimes now shows how much of each usage limit you have used, for every runtime that reports it, even if you only have one account. Claude Code and Codex show bars for the 5-hour and weekly limits. OpenCode shows what it spent this month. When there is no reading yet, the bar says "unknown" instead of showing zero (DOR-2379)
- With two or more Claude accounts, each account shows a colored dot and small bars for its limits. Click the dot to pick the account's color, or go back to its default. When flow is installed, a note under the list takes you to Settings → Flow, where you choose how flow uses your accounts (DOR-2379)
