---
covers:
  - 'feat(status): show usage and context in the status bar from the moment a session opens (DOR-2387)'
  - 'fix(status): read state and expiry from the windows in force, keep cost wording, and never stamp replayed usage as new (DOR-2387)'
---

### Changed

- The status bar now shows how much of your usage limit is used, and how full the chat's context is, as soon as you open a chat, not only when you are close to a limit. Usage limits show for Claude Code and Codex, with one account or many, and every chat on the same account shows the same numbers. OpenCode keeps showing what the chat has cost (DOR-2387)
- The usage and context details now end with how fresh the numbers are, such as "as of 12 min ago" or "just now". A usage number older than an hour is dimmed, and a limit window that has already reset reads "reset" instead of an old percentage (DOR-2387)
- With two or more Claude accounts, usage shows once, on the account chip, instead of twice (DOR-2387)
