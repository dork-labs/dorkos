---
covers:
  - 'fix(server): huge errors stop flooding the terminal (DOR-1728)'
  - 'fix(server): review round 1 — stack boundary, depth marker, per-property reads (DOR-1728)'
---

### Fixed

- A huge error no longer floods your terminal. When something fails with a message megabytes long — a crashed program dumping everything it had — DorkOS now prints the start of it, the lines that say where it happened, and a note saying how big the whole thing was. Log files were already shortened this way; the terminal was not (DOR-1728)

### Note for people upgrading

- The note DorkOS adds when it shortens something now reads `… [truncated, 2400019 characters total]`, giving the full size. It used to say how much was left off instead (`… [truncated, 2395923 more characters]`), so any saved search that looks for the old wording in `~/.dork/logs/` will stop matching (DOR-1728)
