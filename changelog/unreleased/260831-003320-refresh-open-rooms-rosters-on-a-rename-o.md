---
covers:
  - "fix(client): refresh open rooms' rosters on a rename or profile edit (DOR-1114)"
  - "fix(client): move DOR-1114's room sweep to onSuccess so a refused save costs nothing (adversarial review)"
---

### Fixed

- Renaming an agent, or changing your own name, photo, or handle, now updates
  right away in any room you already have open, instead of showing the old
  name until something else happened to refresh it (DOR-1114)
