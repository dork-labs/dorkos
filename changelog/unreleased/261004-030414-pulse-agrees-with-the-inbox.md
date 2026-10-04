---
covers:
  - 'fix(client): Pulse agrees with the Inbox on what needs you (DOR-2578)'
  - 'fix(client): Home only says all quiet when nothing waits in the Inbox (DOR-2578)'
---

### Fixed

- The Pulse panel no longer says "Nothing needs you" while the Inbox shows something waiting. When a decision an extension asked about, an approval, a question from an agent, or an extension waiting to be turned on is in your Inbox, Pulse now says what is waiting, in the same words the Inbox uses, with a button that opens it. The "All quiet." line on Home follows the same rule, and stays hidden until it has checked (DOR-2578)
