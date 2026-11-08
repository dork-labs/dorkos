---
covers:
  - 'fix(browser): agent browsers never start signed in to DorkOS itself (DOR-3957)'
---

### Fixed

- Sign-ins saved with `dorkos browser login` no longer include your DorkOS sign-in. An agent's browser starts signed out of DorkOS, even with login on. Older saved files are cleaned when DorkOS starts. Other sites on this computer's own addresses, like `localhost`, are left out too (DOR-3957).
- DorkOS now warns in its log when an agent's Claude Code loads a browser server outside DorkOS's protections: one that uses your real Chrome, keeps its own browser profile, or can open any site (DOR-3957).
