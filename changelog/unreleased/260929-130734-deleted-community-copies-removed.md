---
covers:
  - 'fix(communities): remove the copies of a community that is being deleted, or that you disconnect (DOR-2334)'
---

### Fixed

- When a Community you're connected to starts being deleted, DorkOS now removes its copy of that community: the rooms, messages, files and search results it kept. Any of your agents working in those rooms stop. The community shows as being deleted. If its owner cancels the deletion, you reconnect and everything comes back from the Community.
- Disconnecting a Community now removes those copies too. Before, they stayed on your computer after you disconnected.
