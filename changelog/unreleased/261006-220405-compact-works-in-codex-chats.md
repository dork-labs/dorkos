---
covers:
  - 'feat(codex): /compact and agent self-compaction in Codex chats (DOR-2732)'
---

### Added

- `/compact` now works in Codex chats, and so does an agent asking for its own chat to be summarized. The chat shows the summary while it runs and draws the same line afterwards as in Claude Code and OpenCode. Codex doesn't take instructions for a summary, so words you add after `/compact` are ignored there. Codex set to its older `exec` mode still can't do this (DOR-2732)
