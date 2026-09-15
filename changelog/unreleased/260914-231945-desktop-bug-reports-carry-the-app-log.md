---
covers:
  - "feat(desktop): bug reports sent from the desktop app include the app's own recent log (DOR-2045)"
  - "fix(desktop): read Windows logs, keep the shell's own [server] lines, and drop URL queries from the excerpt (DOR-2045)"
  - 'fix(feedback): budget the two log excerpts separately so both survive the report cap (DOR-2045)'
---

### Added

- Desktop: when you send feedback from the desktop app, the report now includes the app's own recent log lines (never the server's), so a problem like the window reloading itself can be seen from the report (DOR-2045)
