---
covers:
  - 'fix(client,e2e): a dropdown list that is closing no longer eats your next click (DOR-1835)'
---

### Fixed

- Picking from a dropdown list no longer eats your next click. If you reopened one straight after closing it, the press did nothing and you had to press again — the list that had just closed was still on screen finishing its fade, and it was closing the one your press had opened. The same press now works the first time (DOR-1835)
