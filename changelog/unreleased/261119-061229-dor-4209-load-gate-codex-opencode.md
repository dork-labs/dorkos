---
covers:
  - "feat(runtimes): Codex and OpenCode agents' heavy shell jobs wait their turn too (DOR-4209)"
---

### Added

- Agents on OpenCode now wait their turn for heavy jobs too, like builds, test suites and installs: one at a time on the computer, and longer while it is busy. They join the same line as agents on Claude Code, and the chat shows its place in line. Two heavy jobs from the same chat share its turn rather than wait for each other. Agents on Codex join the same line, but only for a job Codex stops to ask you about first: that job waits its turn before you are asked, then runs as soon as you approve. A job Codex runs without asking, which is every job on Full access, does not wait yet (DOR-4743). Quick commands like `ls` never wait (DOR-4209)
