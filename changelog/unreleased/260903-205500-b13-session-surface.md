---
covers:
  - 'fix(client): a finished plan folds itself away (DOR-1759)'
  - 'fix(client): one offer at a time above the composer (DOR-1759)'
  - 'fix(client): Pulse stops repeating the page it sits beside (DOR-1759)'
---

### Fixed

- The to-do list an agent writes above the message box now opens while the agent is working and folds back to its one-line progress count when the turn is done, and a long list scrolls inside its own box instead of pushing the conversation off a phone screen (DOR-1759)
- The space just above the message box now shows one thing at a time. Suggested replies, an add-on's offer and the question about turning on notifications used to stack up together; whichever matters most speaks, and the rest wait their turn (DOR-1759)
- The Pulse panel no longer repeats what the page beside it already shows: its activity peek is gone on the Activity page, and its "Needs attention" list is gone on Home (DOR-1759)
