---
covers:
  - 'fix(server): errors folded into log context stop flooding either destination (DOR-1827)'
  - 'fix(server): review round 1 — logError totality and the crash handlers (DOR-1827)'
---

### Fixed

- Huge errors are now shortened in more places. DorkOS already shortened an error it was reporting on its own, but not one tucked into a wider line of detail — and those lines used to carry the whole thing, filling a log file with a single 1.2 MB line. Crash reports and the failures your agents' tools report now get the same short version, with the same note saying how big the original was (DOR-1827)

### Note for people upgrading

- The two lines DorkOS writes when it crashes (`Uncaught exception`, `Unhandled promise rejection`) now record the failure under `error`, the name every other error line in `~/.dork/logs/` already uses. It used to be `message` on those two lines only, so a saved search looking for that will need updating (DOR-1827)
