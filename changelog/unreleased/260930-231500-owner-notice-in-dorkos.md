---
covers:
  - 'feat(communities): tell the owner on their DorkOS connection when someone asks to take over their community (DOR-2543)'
  - 'fix(client): match the connection lifecycle type in the owner notice showcase and test (DOR-2543)'
  - 'feat(communities): notify the owner through the Inbox and mark the completion theirs at the source (DOR-2543)'
  - 'fix(server): record an owner notice only once its notification exists (DOR-2543)'
  - 'fix(client): call it a space in the owner notice copy and guide (DOR-2543)'
---

### Added

- If someone asks to make someone else the owner of a space you own, DorkOS now tells you. The space's row in the switcher gets a warning dot, and its page shows when the change could happen, only what you can do about it, and an **Open space** button to keep ownership. Your Inbox gets one notification when DorkOS first sees the request and one if it goes through, even after DorkOS restarts or updates. DorkOS checks while the app is open, and a finished request is only shown for a week. Admins and members see nothing (DOR-2543)
