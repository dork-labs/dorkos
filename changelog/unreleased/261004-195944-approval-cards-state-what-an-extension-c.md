---
covers:
  - 'feat(extensions): approval cards state what an extension can reach, and the yes echoes it (DOR-2686)'
  - 'feat(marketplace): the install preview says what each extension can reach (DOR-2686)'
  - 'feat(extensions): the card explains a stopped server half, with Reload (DOR-2686)'
  - "feat(marketplace): a dev link's card lists what each extension can reach, and binds the yes to it (DOR-2686)"
---

### Added

- Before you turn on an extension, its card now says what it can reach: whether it runs inside DorkOS with full access to your computer, or separately, and then which sites it can connect to, which programs it can start, and whether it can message your agents. The same lines show before you install a package from the Marketplace, and when you link a folder you are working on. If an extension asks for more after you said yes, the new card starts with what changed. If it changes while the card is open, your yes is not used, and the card shows the new list instead.
