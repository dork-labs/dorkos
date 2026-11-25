---
covers:
  - 'fix(runtimes): a Codex agent knows the GitHub CLI can’t sign in, and says so (DOR-4028)'
---

### Fixed

- A Codex agent now knows that the GitHub CLI (`gh`) can't sign in from its chats, because DorkOS keeps GitHub's sign-in protected. Instead of failing quietly, it tells you when it needs GitHub.
