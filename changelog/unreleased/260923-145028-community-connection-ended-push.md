---
covers:
  - 'fix(community): push connection changes so a window leaves an ended Community in seconds'
  - 'fix(community): send one connection-change frame per write, not per row'
---

### Fixed

- When you leave or are removed from a community, the app notices within seconds. Before, a window could keep showing that community for up to half a minute before it moved you back to your own DorkOS.
