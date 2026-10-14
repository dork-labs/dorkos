---
covers:
  - 'perf(server): the five-minute agent check writes only what changed (DOR-2900)'
---

### Fixed

- DorkOS no longer rewrites its agent list and message rules every five minutes for nothing. Its regular check of your agents rewrote each agent's record and saved the message rules file about 30 times in a row, even when nothing had changed. Each save also made DorkOS reload that file. Now it writes only when something actually changed (DOR-2900)
