---
covers:
  - 'feat(status): show usage and context in the status bar from the moment a session opens (DOR-2387)'
---

### Changed

- The status bar now shows how much of your usage limit is used, and how full the chat's context is, as soon as you open a chat, not only when you are close to a limit. This works for Claude Code, Codex and OpenCode, with one account or many, and every chat on the same account shows the same numbers (DOR-2387)
- The usage and context details now end with how fresh the numbers are, such as "as of 12 min ago" or "just now". A usage number older than an hour is dimmed, and a limit window that has already reset reads "reset" instead of an old percentage (DOR-2387)
- With two or more Claude accounts, usage shows once, on the account chip, instead of twice (DOR-2387)
