---
covers:
  - 'fix(communities): remove the copy of a community its host took down (DOR-2334)'
  - 'fix(communities): show reconnecting, not "taken down", once a takedown is lifted (DOR-2334 review)'
---

### Fixed

- When the host of a Community you're connected to takes it down, DorkOS now removes the rooms, messages, files and search results it kept from it, stops your agents working there, and says the host took it down. If the host puts it back, you connect again and it fills in from the Community. A host suspending a community removes nothing.
