---
covers:
  - 'fix(server): the live session stream says where a turn came from (DOR-1141)'
---

### Fixed

- **A room's agent no longer flashes as you.** When a channel or a direct message sets an agent
  working, the live update your cockpit gets now says the turn came from that room. Before, it
  arrived unlabelled, so for a moment ⌘K's "Continue" list and the sidebar's live counts filed
  the agent's work as a conversation you had started yourself, until the next refresh put it
  right (DOR-1141)
