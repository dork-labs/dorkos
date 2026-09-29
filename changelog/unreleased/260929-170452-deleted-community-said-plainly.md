---
covers:
  - 'fix(communities): remove the copy of a deleted community, and offer to remove one that seems to be gone (DOR-2334)'
  - 'fix(communities): reset the not-found count on any real answer, and say plainly what the Community said (DOR-2334 review)'
---

### Fixed

- When a Community you're connected to has been deleted, DorkOS now notices, even if it was offline while that happened. It removes the rooms, messages, files and search results it kept, stops your agents working there, and shows the community as deleted.
- If a Community keeps saying it doesn't exist for two weeks, DorkOS shows that it seems to be gone and offers a **Remove local copy** button. Nothing is removed until you choose to, because a missing community and a misconfigured one look the same from here.
