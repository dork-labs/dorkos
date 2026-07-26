---
covers:
  - "refactor(mcp): derive the mirrored tool lists from one source (DOR-499)"
---

### Fixed

- Scanning for agents from outside DorkOS can now show the agents it already knows about. The scan tool always supported asking for them, but the outside connection did not offer the option, so there was no way to ask for it. It also said it looks three folders deep by default when it really looks five.
- The Tools screen was underselling what your agents can always do. It listed six tools that are on no matter what, leaving out the three that let an agent read its own preview window. All nine were always available; now the screen says so.
