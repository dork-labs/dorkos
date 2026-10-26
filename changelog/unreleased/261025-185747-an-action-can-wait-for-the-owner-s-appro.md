---
covers:
  - "feat(connectors): an action can wait for the owner's approval (DOR-3265)"
  - "feat(connectors): a held request resends only by its approved hash, and carries the turn's marks (DOR-3265)"
---

### Added

- Groundwork for actions that wait for your approval. The app now understands when DorkOS Cloud holds an action until you approve it, and never treats that action as done. Nothing on screen shows it yet (DOR-3265)
