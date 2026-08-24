---
covers:
  - 'fix(server,desktop): always load the current interface after an update'
---

### Fixed

- After an update, DorkOS now always loads the new interface. Before, your browser or the desktop app could hold on to a saved copy of the old one, which could leave you looking at a blank window until you cleared it by hand.
