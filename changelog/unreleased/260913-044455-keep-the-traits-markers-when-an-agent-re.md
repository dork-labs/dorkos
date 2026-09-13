---
covers:
  - 'fix(mesh): keep the TRAITS markers when an agent rewrites its own SOUL.md'
---

### Fixed

- An agent that rewrote its own personality file could switch its personality off by accident. The top of that file is written by DorkOS from the six personality dials you set, and an agent saving the file without it left the dials showing your choice while none of it reached the agent again. DorkOS now keeps that part of the file whatever an agent sends.
