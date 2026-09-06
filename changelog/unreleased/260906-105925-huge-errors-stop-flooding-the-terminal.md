---
covers:
  - 'fix(server): huge errors stop flooding the terminal (DOR-1728)'
---

### Fixed

- A huge error no longer floods your terminal. When something fails with a message megabytes long — a crashed program dumping everything it had — DorkOS now prints the start of it, the lines that say where it happened, and a note saying how big the whole thing was. Log files were already shortened this way; the terminal was not (DOR-1728)
