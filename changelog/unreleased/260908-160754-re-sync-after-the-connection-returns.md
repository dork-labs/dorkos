---
covers:
  - 'fix(client): the cockpit re-syncs after the stream comes back'
---

### Fixed

- DorkOS now refreshes itself when its live connection comes back. After a dropped connection (a sleeping laptop, a restarted server, a moment of bad wifi), rooms, sessions and agents could keep showing what they showed before the drop until something else happened to refresh them. The catch-up that was meant to run on reconnect never did.
