---
covers:
  - "fix(server): on Full, a package's hooks run without a card and leave one Activity line (DOR-3422)"
  - 'fix(server): on Full, only packages DorkOS installed run their hooks unasked (DOR-3422)'
  - 'test(server): Sync now on Full reads the preset through the shipped reader (DOR-3422)'
  - "fix(server): one recordFullAction, main's shape, for the Full hook rows (DOR-3422)"
  - 'fix(server): a package Full held back waits quietly under Needs you (DOR-3427)'
  - 'fix(server): on Full, a yes covers only the files it named, one passive row per package (DOR-3422, DOR-3433)'
  - 'fix(server): a yes on a quiet row still lands after a restart (DOR-3427)'
  - 'fix(server): a saved quiet row that is not the right shape never stops startup (DOR-3427)'
  - 'fix(server): quiet rows are picked up at startup with relay off too (DOR-3427)'
  - 'fix(server): on Full, hooks that name no file need DorkOS to have installed the package (DOR-3422)'
  - 'fix(server): saved quiet rows that cannot be used are logged and dropped (DOR-3427)'
---

### Fixed

- On the Full setting, a package you installed from the marketplace still asked before it could run commands automatically. Full means nothing new asks, so now those commands run, and Activity shows one line saying so. A package that is in a project but that DorkOS did not install, or whose files changed after install, waits under Needs you instead, and only you can allow it. Nothing stops while it waits, it doesn't ping your phone, and it stays put until you answer instead of coming back every couple of hours. A yes still counts if DorkOS restarted since the row appeared. If that package's commands don't run a file DorkOS can check, a yes can't vouch for them, so they stay held back and Activity tells you how to run them: install the package through DorkOS, or link its folder as a dev link. On every other setting you're still asked, and a package you turned down stays turned down.
