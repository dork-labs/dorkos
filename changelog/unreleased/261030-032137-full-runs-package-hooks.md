---
covers:
  - "fix(server): on Full, a package's hooks run without a card and leave one Activity line (DOR-3422)"
---

### Fixed

- On the Full setting, an installed package that wanted to run commands automatically still asked you first. Full means nothing new asks, so now those commands run, and Activity shows one line saying what was allowed and why. On every other setting you're still asked. If you turned a package down earlier, it stays turned down on Full too.
