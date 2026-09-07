---
covers:
  - 'fix(harness): a blocked hooks projection and a file DorkOS stepped over are different answers (DOR-1842, DOR-1844)'
---

### Fixed

- On Windows, a skill kept somewhere else in your project and linked into `.agents/skills` now gets the right kind of shortcut. DorkOS asked Windows for a file shortcut where a folder one was needed, which fails unless you are an admin or have Developer Mode on (DOR-1844)
