---
covers:
  - 'feat(communities): tell the owner on their DorkOS connection when someone asks to take over their community (DOR-2543)'
  - 'fix(client): match the connection lifecycle type in the owner notice showcase and test (DOR-2543)'
---

### Added

- If someone asks the host to make someone else the owner of a community you own, DorkOS now tells you. The community's row in the switcher gets a warning dot, and its page shows when the change could happen, only what you can do about it, and an **Open community** button to keep ownership. You get one notification when the request appears and one if it goes through. Admins and members see nothing (DOR-2543)
