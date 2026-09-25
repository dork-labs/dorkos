---
covers:
  - 'feat(community): hold a suspended community in one step, and add a host legal hold (DOR-2299)'
  - 'fix(community): harden the legal hold after review (DOR-2299)'
---

### Added

- If you run a Community server, you can now put a suspended community on hold in one step. It goes straight from suspended to on hold and is never live in between (DOR-2299).
- A host can place a legal hold on a community so it can't be permanently deleted until the hold is released: not by the host, not by the owner's own request, and not by a deletion that is already running. It needs its own host key permission, `communities:legal_hold`, and every change is recorded in the host audit log. Owners and members are not told (DOR-2299).
