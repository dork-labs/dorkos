---
covers:
  - 'feat(community): operators can create a space under a reserved name (DOR-2848)'
  - "fix(community): a reserved-name grant goes with the space's hold on the name (DOR-2848)"
  - 'fix(community): a renamed space takes its reserved name back, and only the reserved-name scope releases it (DOR-2848)'
---

### Added

- People who run a Community server can now give one of its reserved web addresses, such as `official`, to a new space of their own. It takes a key made for that one job and a written reason, and the server keeps a record of who gave the address out and why. Everyone else is still refused every reserved address, and addresses that are pages of the server can never be given out. See "Giving a reserved web address to a community" in the server's operations guide.
