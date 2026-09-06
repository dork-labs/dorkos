---
covers:
  - 'fix(marketplace): direct installs check their address like sources do (DOR-1799)'
  - 'fix(marketplace): refuse git:// installs, and cover the ls-remote door (DOR-1799)'
---

### Fixed

- Installing a package straight from an address now checks the address the same way marketplace sources are checked. An install address is a git repository over `https://`, `ssh://` or `git@host:path`, or a `file://` folder on your own machine; anything else is turned down before DorkOS runs anything, with a note saying what to use instead (DOR-1799)
