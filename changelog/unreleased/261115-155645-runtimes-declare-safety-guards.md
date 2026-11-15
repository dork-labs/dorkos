---
covers:
  - 'fix(runtimes): each runtime declares the safety guards it enforces, and one that declares none is treated as having none (DOR-3596)'
  - 'fix(runtimes): say what each guard really holds, and prove the shell hook, not just its check (DOR-3596)'
---

### Security

- Each kind of agent (Claude Code, Codex, OpenCode, Doe) now states which safety checks it enforces, and DorkOS treats one that states nothing as having none. A new kind of agent can no longer skip a check without anyone noticing (DOR-3596).
- Named browser profiles still work only for Claude Code agents. The message other agents get now says their runtime can't use profiles yet, instead of naming only Codex and OpenCode.
