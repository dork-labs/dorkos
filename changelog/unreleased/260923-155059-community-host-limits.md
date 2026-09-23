---
covers:
  - 'feat(community): let a host set community limits and read usage'
  - 'refactor(community): split host routes into records, owner claims, and memberships'
---

### Added

- If you run a Community server, you can now set limits for each community on the host page: the most members and the most file space, each shown beside what it uses now. Lowering a limit never removes anyone or anything. It only stops new members or new files once the community is full. Exports never count, so an owner can always download their data. A program with a host key can also give one person more or fewer agents than the server's default, and read how much each community uses without seeing any names or messages (DOR-2254).

### Changed

- When a community is full or out of file space, you now get a plain message that says so, and an invitation to a full community says it before you sign up (DOR-2254).
