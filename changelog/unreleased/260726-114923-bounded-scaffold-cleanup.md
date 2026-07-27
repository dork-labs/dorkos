---
covers:
  - 'fix(security): bound agent scaffold cleanup and block extension name traversal (DOR-507)'
---

### Fixed

- Setting up an agent in a folder you already have can no longer delete that folder. If setup stops partway, such as when the disk is full, DorkOS takes back only the files and folders it just made, leaves everything of yours alone, and tells you if anything is left over (DOR-507)

### Security

- Refuse extension names that would put a new extension outside your extensions folder (DOR-507)
