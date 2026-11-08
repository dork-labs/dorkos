---
covers:
  - 'feat(extensions): a mini app can declare the apps it reads, and a change to that list waits for a person (DOR-3547)'
  - 'feat(connectors): a mini app reads a connected app through DorkOS, with no token and only what a person approved (DOR-3547)'
  - 'refactor(extensions): the lifecycle wires ctx.connections in one line, inside its size limit'
  - "fix(connectors): a mini app reads only on a person's yes, and gets no answer if its access changed while the app replied"
---

### Added

- Let a mini app that runs in its own sandbox read from an app you connected, after you approve it once: it never sees a password or token, it can only read, and every read shows under its name (DOR-3547)
