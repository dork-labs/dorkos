---
covers:
  - 'fix(runtimes): say what happens to work that runs after a reply (DOR-2717)'
---

### Added

- A new docs page, "Work That Runs After a Reply", lists what Claude Code, Codex and OpenCode can leave running after they reply, and what happens to it when DorkOS restarts or a setting changes (DOR-2717)

### Fixed

- When OpenCode stops in the middle of a reply, the chat now says the reply ended early and asks you to send your message again, instead of showing a raw error (DOR-2717)
- Claude Code agents are now told that a reminder saved to disk is not reliable in DorkOS, and to use Tasks for anything on a schedule (DOR-2717)
