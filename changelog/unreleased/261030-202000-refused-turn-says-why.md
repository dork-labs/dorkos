---
covers:
  - 'fix(server): a refused turn says why, in the chat, the log and the report back (DOR-3167)'
  - "refactor(server): the turn stream's per-event tap gets its own file, so trigger-turn.ts stays under 500 lines (DOR-3167)"
---

### Fixed

- When Codex, Claude Code or OpenCode refuses a turn, the chat names which one, quotes what it said, and offers the next step. A chat started from another chat now passes that reason back instead of only saying the turn failed (DOR-3167)
