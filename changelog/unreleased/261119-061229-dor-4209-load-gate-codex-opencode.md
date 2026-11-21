---
covers:
  - "feat(runtimes): Codex and OpenCode agents' heavy shell jobs wait their turn too (DOR-4209)"
  - "fix(runtimes): a stopped OpenCode chat's waiting command is refused, never decided (DOR-4209)"
  - 'feat(load-gate): a person sees the waiting heavy jobs and can let one through (DOR-4209)'
  - 'fix(load-gate): the waiting-jobs card fits a phone and a narrow panel (DOR-4209)'
  - "fix(load-gate): review fixes for the person's view of the waiting line (DOR-4209)"
  - 'fix(load-gate): calmer waiting-jobs rows: no main button, no lines (DOR-4209)'
---

### Added

- Agents on OpenCode now wait their turn for heavy jobs too, like builds, test suites and installs: one chat at a time on the computer, and longer while it is busy. They join the same line as agents on Claude Code, and the chat shows its place in line. A chat's own heavy jobs, its helpers' included, share its turn rather than wait for each other, so once its turn comes it can run several at once. Agents on Codex join the same line, but only for a job Codex stops to ask you about first: that job waits its turn before you are asked, then runs as soon as you approve. Quick commands like `ls` never wait (DOR-4209)
