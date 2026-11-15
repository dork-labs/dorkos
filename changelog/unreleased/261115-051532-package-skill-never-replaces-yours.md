---
covers:
  - "fix(harness): a package skill never replaces a person's own skill of the same name"
  - 'fix(harness): skip same-name package skills only where a by-name harness is enabled'
  - 'fix(harness): close the two gaps Security found in the same-name package skill skip'
  - "fix(opencode): quote a package's skill folder in the agent's skipped-skills note"
  - 'fix(harness): a package skill never replaces a skill in your home folder either'
---

### Fixed

- On OpenCode, which keeps only one skill per name, an installed package can no longer swap in its own skill for a skill of yours with the same name, whether yours is in the project or in your home folder. DorkOS leaves the package's skill out, says so on the install screen, and tells the agent which one it has (DOR-4387, DOR-4392).
