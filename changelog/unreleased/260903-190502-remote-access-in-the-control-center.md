---
covers:
  - 'feat(client): remote access in the Control Center, with a beacon in the top bar (DOR-1743)'
  - 'test(client): pin that owner setup resumes the start it interrupted (DOR-1743)'
  - 'fix(client): a refused stop says why, and a tunnel the server cannot see stops reading as live (DOR-1743)'
---

### Added

- Remote access now lives in the Control Center — flip it on, and a globe appears in the top bar with your link and QR code one click away
- ⌘K knows about it too: search for "remote" to copy the link, show the QR code, or turn remote access on or off

### Changed

- The globe only appears while remote access is actually running, and holds still once it is — one quiet ripple when your phone can reach this machine, and nothing after that
- If your tunnel drops, every part of DorkOS finds out at once instead of waiting for the next page refresh

### Fixed

- If turning remote access off doesn't work, DorkOS now tells you why instead of quietly leaving the switch on
- The globe no longer keeps saying you are reachable after DorkOS can no longer find your tunnel
