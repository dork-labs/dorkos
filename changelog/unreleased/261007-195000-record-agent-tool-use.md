---
covers:
  - 'feat(audit): record every tool an agent uses, in Claude Code, Codex and OpenCode (DOR-2738)'
---

### Added

- The record now holds the tools an agent uses, in DorkOS, Claude Code, Codex or OpenCode: the command it ran, the file it changed or the page it fetched, and whether it worked. Each line points to the chat it happened in, where the full detail stays. In Codex and OpenCode, a helper agent's own tools are not listed yet, only that it started (DOR-2738)
- Tool cards in DorkOS runtime chats now show what each tool was asked to do, as they already did for Claude Code, Codex and OpenCode (DOR-2738)
