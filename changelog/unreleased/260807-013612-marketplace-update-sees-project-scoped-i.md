---
covers:
  - 'fix(server): marketplace update sees project-scoped installs'
---

### Fixed

- Updating a marketplace package that you installed into a single project now works. Before,
  the updater only looked at packages installed for your whole machine, so it answered
  "Package not installed" for anything that lived in one project — even though it would have
  installed the new version right there. When the same package is installed both ways, the
  project's copy is the one that gets updated.
