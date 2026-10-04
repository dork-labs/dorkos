---
covers:
  - 'feat(extensions): approval cards state what an extension can reach, and the yes echoes it (DOR-2686)'
  - 'feat(marketplace): the install preview says what each extension can reach (DOR-2686)'
  - 'feat(extensions): the card explains a stopped server half, with Reload (DOR-2686)'
  - "feat(marketplace): a dev link's card lists what each extension can reach, and binds the yes to it (DOR-2686)"
  - "fix(extensions): screens-only cards claim no full access, separate runtimes say they can't run yet, and narrowing keeps the yes (DOR-2686)"
---

### Added

- Before you turn on an extension, its card now says what it can reach. One with only screens says its screens run in DorkOS with your access. One whose server part runs inside DorkOS says it has full access to your computer. One built to run separately lists the sites it can connect to, the programs it can start, and whether it can message your agents, and says plainly that its server part can't run in this version yet. The same lines show before you install a package from the Marketplace, and when you link a folder you are working on. If an extension asks for more while the card is open, your yes is not used, and the new card starts with what changed. If it asks for less, your yes still counts.
