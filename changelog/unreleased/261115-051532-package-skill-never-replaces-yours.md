---
covers:
  - "fix(harness): a package skill never replaces a person's own skill of the same name"
---

### Fixed

- An installed package can no longer swap in its own skill for one of yours with the same name. OpenCode keeps only one skill per name, so DorkOS leaves the package's skill out, says so on the install screen, and tells the agent which one it has (DOR-4387).
