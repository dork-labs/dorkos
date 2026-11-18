---
covers:
  - 'fix(chats): a chat stopped by another chat says which one, never "the user" (DOR-4668)'
---

### Fixed

- When one chat interrupts or stops another, the stopped chat now says which chat did it, and its
  agent is told no person stopped it. Before, it read as a person's Stop, so the agent waited for
  someone who never asked it to stop.
