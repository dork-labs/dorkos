---
covers:
  - "fix(server): on Full, a package's hooks run without a card and leave one Activity line (DOR-3422)"
  - 'fix(server): on Full, only packages DorkOS installed run their hooks unasked (DOR-3422)'
  - 'test(server): Sync now on Full reads the preset through the shipped reader (DOR-3422)'
---

### Fixed

- On the Full setting, a package you installed from the marketplace still asked before it could run commands automatically. Full means nothing new asks, so now those commands run, and Activity shows one line saying so. A package that is in a project but that DorkOS did not install, or whose files changed after install, waits under Needs you instead, and only you can allow it. Nothing stops while it waits. On every other setting you're still asked, and a package you turned down stays turned down.
