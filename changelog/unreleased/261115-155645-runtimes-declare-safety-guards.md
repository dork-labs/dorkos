---
covers:
  - 'fix(runtimes): each runtime declares the safety guards it enforces, and one that declares none is treated as having none (DOR-3596)'
---

### Security

- Each kind of agent (Claude Code, Codex, OpenCode, Doe) now states which safety checks it enforces, and DorkOS treats one that states nothing as having none. A new kind of agent can no longer skip a check without anyone noticing (DOR-3596).
- Named browser profiles stay limited to agents that can't read your saved sign-ins from their command line. Today that is Claude Code. The message an agent gets now says its runtime can't use profiles yet, instead of naming only Codex and OpenCode.
