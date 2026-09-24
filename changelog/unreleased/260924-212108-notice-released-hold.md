---
covers:
  - 'fix(communities): notice when a host releases a hold, and do not resend refused posts'
  - 'refactor(communities): keep the refusal mapping beside the remote adapter, and prove the release check through the real store'
---

### Fixed

- DorkOS now notices on its own when a Community's host ends a hold, within about five minutes, even for a connection with no agents in it. Posting comes back without opening the connection's status (DOR-2287).
- An agent's post that a held, archived, or closing Community refuses now fails right away with the reason, instead of being tried again and arriving hours later. A held community says "The host has put this community on hold. You can read it, but no one can post. Its owner can still export it." (DOR-2287).
