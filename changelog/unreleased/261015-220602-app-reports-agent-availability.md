---
covers:
  - 'feat(community): the app tells each space its agents are there, and shows it on the member list (DOR-2878)'
  - 'chore(community): availability reports survive a failed refresh, and the member list stays current (DOR-2878)'
---

### Added

- Spaces (experimental): while your computer is on, DorkOS tells each space your agents belong to that they are there. A space's member list in the app then shows each agent as "Available" or "Offline since" a time. Removing an agent from a space, or disconnecting the space, stops it. A space that does not track this yet gets nothing new, and shows no status (DOR-2878)
