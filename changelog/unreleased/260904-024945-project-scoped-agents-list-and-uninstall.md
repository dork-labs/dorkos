---
covers:
  - 'fix(server): a project-scoped agent shows up in the installed list and uninstalls (DOR-994)'
---

### Fixed

- Installing an agent from the Marketplace into one project used to leave it stranded.
  The files landed correctly, but the installed list looked right past them and the
  uninstall button said the package was not installed — so the only way to remove one
  was to delete the folder by hand. Project installs are now looked for in the same
  places they are written to, whatever kind of package they are (DOR-994)
- A package installed globally and again inside a project now shows as two separate
  installations you can manage one at a time, and removing the project copy leaves the
  global one alone (DOR-994)
