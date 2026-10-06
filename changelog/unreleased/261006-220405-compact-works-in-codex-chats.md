---
covers:
  - 'feat(codex): /compact and agent self-compaction in Codex chats (DOR-2732)'
  - 'feat(opencode): say how full an OpenCode chat is, so the 80% note works there too (DOR-2732)'
  - "fix(codex): close the review's gaps in Codex compaction (DOR-2732)"
  - 'fix(session): bound the context-window read and the stray-summary wait (DOR-2732)'
---

### Added

- `/compact` now works in Codex chats, and so does an agent asking for its own chat to be summarized. The chat shows the summary while it runs and draws the same line afterwards as in Claude Code and OpenCode. Codex doesn't take instructions for a summary, so words you add after `/compact` are ignored there. Codex set to its older `exec` mode still can't do this (DOR-2732)

### Fixed

- OpenCode chats now say how much room is left. DorkOS reads each model's size from OpenCode's model list, so an OpenCode agent also gets the note at 80% full. The token count now includes the part of the conversation OpenCode had cached, which it used to leave out (DOR-2732)
