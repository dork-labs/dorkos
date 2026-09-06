---
covers:
  - 'fix(server): local installs and template addresses answer to the same boundary (DOR-1825)'
---

### Fixed

- DorkOS now refuses to read or install from folders outside your allowed workspace, however the address is spelled. A package install aimed at a `file://` address used to skip that check — it could list the contents of a folder you never opened up, and copy that folder in (DOR-1825)
- Creating an agent from a template now checks the address up front and says plainly when it isn't one DorkOS can download from, instead of failing partway through with a server error (DOR-1825)

### Changed

- Template addresses are now limited to the ones DorkOS can actually download from: `https://`, `git@host:path`, a `github:`, `gitlab:` or `bitbucket:` shorthand (add `#branch` to pin a version), or an `owner/repo` name. Other spellings — `ssh://`, `git://`, plain `http://`, the `gh:` and `sourcehut:` shortcuts, and one-word template names — are now refused with a message naming what to use instead, because none of them ever finished a download (DOR-1825)
