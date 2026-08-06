---
covers:
  - "fix(client): expanding an agent shows its sessions regardless of the window's directory (DOR-929)"
---

### Fixed

- An agent's profile Sessions tab and the command-palette preview now show that agent's
  conversations even when the current window is pointed at a different project. Before, they
  read only the window's own directory, so every agent except the one this window had open
  looked like it had no conversations — an agent could appear to be working while claiming
  none (DOR-929)
