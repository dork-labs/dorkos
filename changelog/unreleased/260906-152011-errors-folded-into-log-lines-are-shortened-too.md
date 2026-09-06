---
covers:
  - 'fix(server): errors folded into log context stop flooding either destination (DOR-1827)'
  - 'fix(server): review round 1 — logError totality and the crash handlers (DOR-1827)'
  - 'fix(server): review round 2 — correct the crash-line note and the initError sites (DOR-1827)'
---

### Fixed

- Huge errors are now shortened in more places. DorkOS already shortened an error it was reporting on its own, but not one tucked into a wider line of detail — and those lines used to carry the whole thing, filling a log file with a single 1.2 MB line. Crash reports and the other failures DorkOS reports now get the same short version, with the same note saying how big the original was (DOR-1827)

### Note for people upgrading

- The line DorkOS writes when it crashes (`Uncaught exception`) now records the failure under `error`, the name every other error line in `~/.dork/logs/` already uses; it used to be `message` on that line only, so a saved search for it will need updating. The `Unhandled promise rejection` line keeps its wording and gains the fields it was dropping — the error's name, and codes like `ENOENT` (DOR-1827)
