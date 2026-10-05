---
covers:
  - "feat(extensions): serve an isolated extension's router over IPC, with the person verdict (DOR-2686)"
  - 'feat(extensions): start isolated extensions through the real lifecycle, with restarts (DOR-2686)'
  - 'docs(extensions): document extensions that run separately (DOR-2686)'
---

### Added

- An extension can now run separately from DorkOS, as its own program, limited to the sites, programs and agent access its card listed when you said yes. If it crashes, freezes or runs out of memory, the rest of DorkOS keeps working. DorkOS starts it again after 1 second, then 5, then 30, and after 3 stops in 10 minutes it stays off until you click Reload. Your sign-in never reaches it. Its screens still run with your access, a program it may run has your full access, and its list of sites is a check inside its own program, not a firewall. It has been tested on macOS, including the desktop app, and on Linux, but not yet confirmed on Windows. These extensions can't give your agents tools yet. (DOR-2686)
