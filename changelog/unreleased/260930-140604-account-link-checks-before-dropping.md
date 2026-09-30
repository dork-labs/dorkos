---
covers:
  - 'fix(server): check the account link before dropping it after one refused request (DOR-2620)'
  - 'fix(server): cool down the link check and say "refused", not "unlinked" (DOR-2620)'
---

### Fixed

- Your DorkOS account link no longer drops itself when one app-connection request is refused. It checks the link first, and only unlinks this computer when the account really has let it go. Before, a single refused request could unlink you and leave your connected apps stranded until you linked again (DOR-2620)
