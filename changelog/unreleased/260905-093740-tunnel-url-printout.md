---
covers:
  - 'fix(cli): the tunnel URL printout listens to the live server, not a bundled copy (DOR-1745)'
---

### Fixed

- Starting DorkOS with `--tunnel` now prints the address your phone can reach it on, and a QR code for getting there without typing it. Turning Remote Access on later from the app prints it too. Both were silent before: the terminal was watching a copy of the tunnel that never actually ran, and the QR code was failing in a way nothing reported (DOR-1745)
