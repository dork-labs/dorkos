---
covers:
  - "feat(extensions): serve an isolated extension's router over IPC, with the person verdict (DOR-2686)"
  - 'feat(extensions): start isolated extensions through the real lifecycle, with restarts (DOR-2686)'
  - 'docs(extensions): document extensions that run separately (DOR-2686)'
  - 'fix(extensions): isolated replies keep only allowed headers, connections have flow control, new code starts fresh (DOR-2686)'
  - 'test(extensions): make the isolated go-live suite deterministic under load (DOR-2686)'
---

### Added

- An extension can now run separately from DorkOS, as its own program, limited to the sites, programs and agent access its card listed when you said yes. If it crashes, freezes or runs out of memory, the rest of DorkOS keeps working. DorkOS starts it again after a second, waiting longer each time it stops again, and after 3 stops in 10 minutes it stays off until you click Reload. Your sign-in never reaches it. Its screens still run with your access, a program it may run has your full access, and its list of sites is a check inside its own program, not a firewall. It has been tested on macOS and Linux. In the desktop app DorkOS has checked that its limits hold, but the extension itself hasn't been run there yet, and it isn't confirmed on Windows yet. (DOR-2686)
