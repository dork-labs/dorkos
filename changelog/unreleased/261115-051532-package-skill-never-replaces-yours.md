---
covers:
  - "fix(harness): a package skill never replaces a person's own skill of the same name"
  - 'fix(harness): skip same-name package skills only where a by-name harness is enabled'
---

### Fixed

- In projects that use OpenCode, an installed package can no longer swap in its own skill for one of yours with the same name. OpenCode keeps only one skill per name, so DorkOS leaves the package's skill out, says so on the install screen, and tells the agent which one it has (DOR-4387).
