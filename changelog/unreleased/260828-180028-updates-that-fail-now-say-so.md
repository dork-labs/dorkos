---
covers:
  - 'fix(desktop,client): tell the truth when an update fails to install (DOR-1454)'
---

### Fixed

- The desktop app now tells you when an update fails to install, instead of
  quietly offering you a restart that cannot work. It writes down which version
  it was about to install, and the next time you open DorkOS it checks whether
  that version is the one actually running. If it isn't, the sidebar says so and
  offers a fresh copy to download — the one thing that always works. Your
  settings and your agents stay exactly where they are. Before this, an update
  could fail every time for weeks with nothing on screen but "Update ready —
  Restart" (DOR-1454)
- Update errors are no longer hidden. A problem that showed up after an update
  finished downloading used to be swallowed by the "Update ready" card, which
  kept sitting there as if everything were fine. Now the card shows what
  actually happened (DOR-1454)
