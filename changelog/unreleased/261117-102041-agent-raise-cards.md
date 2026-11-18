---
covers:
  - 'fix(auth): turning on a chat connection that is already on changes nothing (DOR-4355)'
  - 'feat(auth): an agent asks on a card to let someone reach your agents or widen a chat route (DOR-4355, DOR-4595)'
  - 'fix(auth): an agent raise card never heads with a name an agent can set (DOR-4355)'
  - 'fix(auth): agent raise card lines stay within 15 words (DOR-4355)'
  - 'fix(approvals): a card that grants access never cuts its title short, and an agent raise card shows only what changes (DOR-4355)'
  - "fix(auth): an agent raise card quotes a connection's name in full, as one inert line (DOR-4355)"
  - "fix(auth): a connection's name on an agent raise card turns look-alike double quotes into apostrophes too (DOR-4355)"
  - 'refactor(approvals): the two person bars move to approval-person-bars.ts, so approvals.ts stays under 500 lines (DOR-4355)'
  - 'fix(auth): a request code on the "Confirm it''s you" sheet always comes with its note (DOR-4355)'
  - 'refactor(tasks): the credits-raise guard moves to credits-work.ts, so task-tools.ts stays under 500 lines (DOR-4355)'
---

### Security

- Asking to turn on a chat connection that is already on no longer touches it, so it can't undo you switching it off at the same moment.
- When an agent asks to let someone approve or message your agents on a chat connection, or to let a chat route do more, you get a card instead of a flat no. It names the connection by its type and id, and shows exactly what changes, from how it is now to how it would be. You confirm it's you, and DorkOS makes that one change. The card lasts ten minutes, and it counts once. A card from an agent that read words from outside your team never appears.
- Approval cards no longer cut their title short on a narrow screen. It wraps instead.
