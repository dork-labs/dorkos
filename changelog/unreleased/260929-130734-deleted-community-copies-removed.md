---
covers:
  - 'fix(communities): remove the copies of a community that is being deleted, or that you disconnect (DOR-2334)'
  - 'fix(communities): record a deletion before purging, purge once, and sweep copies of removed connections (DOR-2334 review)'
  - 'fix(communities): make the startup sweep of disconnected copies fail closed (DOR-2334 review)'
---

### Fixed

- When a Community you're connected to starts being deleted, DorkOS now removes its copy of that community: the rooms, messages, files and search results it kept. Any of your agents working in those rooms stop, and the community shows as being deleted, then as deleted once the deletion finishes. If its owner cancels the deletion, you reconnect and the rooms come back from the Community, but you need to add your agents to it again.
- Disconnecting a Community now removes those copies too. Copies left on your computer by an earlier disconnect are removed the next time DorkOS starts.
