---
covers:
  - 'fix(desktop): an exported CA variable never reaches the server or its agents, and the cert loader reads only a small regular file (DOR-3361)'
---

### Fixed

- In the Mac app, a certificate setting another program exports no longer reaches your agents. Only the company certificates file you choose in Settings counts.
- A company certificates file that is not a normal, small file is skipped at once, so it can't stop the Mac app from opening.
