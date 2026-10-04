---
covers:
  - 'fix(client): Pulse agrees with the Inbox on what needs you (DOR-2578)'
  - 'fix(client): Home only says all quiet when nothing waits in the Inbox (DOR-2578)'
  - 'fix(client): address review on Pulse and Home agreeing with the Inbox (DOR-2578)'
  - 'fix(client): Pulse hides its Home duplicate only where the panel is docked (DOR-2578)'
  - 'fix(client): keep the waiting queue honest with Tasks off and after back-to-back events (DOR-2578)'
---

### Fixed

- The Pulse panel no longer says "Nothing needs you" while the Inbox shows something waiting. When a decision an extension asked about, an approval, a question from an agent, or an extension waiting to be turned on is in your Inbox, Pulse now says what is waiting, in the same words the Inbox uses, with a button that opens it. If Pulse can't check everything waiting, it says so and offers to try again, instead of saying all is quiet. The "All quiet." line on Home follows the same rules, and stays hidden until it has checked (DOR-2578)
