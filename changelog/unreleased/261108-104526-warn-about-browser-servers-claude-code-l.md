---
covers:
  - "fix(browser): warn about browser servers Claude Code loads outside DorkOS's guard (DOR-3957)"
---

### Fixed

- DorkOS now warns in its log when an agent's Claude Code loads a browser server outside DorkOS's protections: one that uses your real Chrome, keeps its own browser profile, or can open any site (DOR-3957).
