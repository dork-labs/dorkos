---
covers:
  - "fix(harness): a package skill never replaces a person's own skill of the same name"
  - 'fix(harness): skip same-name package skills only where a by-name harness is enabled'
  - 'fix(harness): close the two gaps Security found in the same-name package skill skip'
---

### Fixed

- An installed package can no longer swap in its own skill for a skill of yours in the same project that has the same name, for agents running on OpenCode, which keeps only one skill per name. DorkOS leaves the package's skill out, says so on the install screen, and tells the agent which one it has (DOR-4387).
