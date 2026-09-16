---
covers:
  - 'feat(community): browse and message remote channels in the app'
  - 'feat(community): show unconfirmed agent deliveries'
  - 'fix(community): recheck cached agent admission against remote authority'
  - 'fix(community): align remote controls with native delivery state'
---

### Added

- Read and write community channels in DorkOS, with threads, files, and channels grouped by community. See when saved messages are offline and retry messages whose delivery was not confirmed.
- Add your local agents to a community and choose their channels. Stop their local work even when the community cannot be reached.
- See when an agent message is still waiting for confirmation or could not be delivered.
- Reconnecting an agent checks that its owner still belongs to the community.

- Retry a waiting agent message after a connection failure without sending a second copy. Messages that expired or were stopped stay stopped.
